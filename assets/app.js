import { initializeAccessibility } from "./accessibility.js";
import { initializePersistentStorage, refreshPersistentStorage } from "./ui-storage.js";

const launchParameters = new URLSearchParams(location.search);
if (launchParameters.has("desktop")) {
  document.body.classList.add("desktop");
  document.getElementById("brandSub").textContent = "Windows 桌面版 · v1.4.8";
}
if (launchParameters.has("token"))
  history.replaceState(
    {},
    "",
    location.pathname + (launchParameters.has("desktop") ? "?desktop=1" : ""),
  );
await initializePersistentStorage();
const fileInput = document.getElementById("fileInput"),
  drop = document.getElementById("drop"),
  status = document.getElementById("fileStatus"),
  workspace = document.getElementById("workspace"),
  notice = document.getElementById("notice"),
  title = document.getElementById("bookTitle"),
  summary = document.querySelector(".summary"),
  answer = document.getElementById("answer");
let sessionId = "",
  backendReady = false,
  analysisHtml = "",
  currentChapterIndex = 0,
  currentBookKey = "",
  selectedParagraph = null,
  selectedText = "",
  selectedLocator = null,
  currentBookData = null,
  readingActive = false,
  readingTimer = null,
  activeQaTopicId = "";
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ],
  );
function openExclusiveModal(modal) {
  document.querySelectorAll(".modal.open").forEach((item) => {
    if (item !== modal) item.classList.remove("open");
  });
  modal.classList.add("open");
}
const BUILTIN_QUOTES = [
  {
    id: "tangong-stars",
    topic: "星辰",
    original: "醉后不知天在水，满船清梦压星河。",
    translation: "",
    author: "唐珙（唐温如）《题龙阳县青草湖》",
    source: "https://www.gushiwen.cn/mingju/juv.aspx?id=e613ae408360",
  },
  {
    id: "libai-stars",
    topic: "星辰",
    original: "危楼高百尺，手可摘星辰。",
    translation: "",
    author: "李白《夜宿山寺》",
    source: "https://www.gushiwen.cn/mingju/juv_abe9088cd9ad.aspx",
  },
  {
    id: "dufu-stars",
    topic: "星辰",
    original: "星垂平野阔，月涌大江流。",
    translation: "",
    author: "杜甫《旅夜书怀》",
    source: "https://www.gushiwen.cn/mingju/juv_fd08a143904f.aspx",
  },
  {
    id: "kant-cosmos",
    topic: "宇宙",
    original:
      "Zwei Dinge erfüllen das Gemüt mit immer neuer und zunehmender Bewunderung und Ehrfurcht: der bestirnte Himmel über mir und das moralische Gesetz in mir.",
    translation:
      "有两样东西，我们越是经常、持久地思考它们，心中就越充满常新而日增的惊叹与敬畏：我头顶的星空和我心中的道德法则。",
    author: "Immanuel Kant《Kritik der praktischen Vernunft》",
    source:
      "https://bibdig.biblioteca.unesp.br/bitstreams/0b89a3ea-e329-4c4e-81aa-9030cbb7860f/download",
  },
  {
    id: "dante-stars",
    topic: "宇宙",
    original: "L’amor che move il sole e l’altre stelle.",
    translation: "那推动太阳和群星运转的爱。",
    author: "Dante Alighieri《Paradiso》XXXIII",
    source: "https://www.gutenberg.org/ebooks/4544.html.images",
  },
  {
    id: "whitman-stars",
    topic: "宇宙",
    original:
      "I believe a leaf of grass is no less than the journey-work of the stars.",
    translation: "我相信，一片草叶并不逊于群星运行的伟业。",
    author: "Walt Whitman《Song of Myself》",
    source:
      "https://www.poetryfoundation.org/articles/68627/for-the-sake-of-peoples-poetry",
  },
  {
    id: "keats-star",
    topic: "星辰",
    original: "Bright star, would I were stedfast as thou art—",
    translation: "明亮的星啊，但愿我能像你一样坚定不移——",
    author: "John Keats《Bright star, would I were stedfast as thou art》",
    source:
      "https://www.poetryfoundation.org/poems/44468/bright-star-would-i-were-stedfast-as-thou-art",
  },
  {
    id: "shakespeare-music",
    topic: "音乐",
    original: "If music be the food of love, play on.",
    translation: "如果音乐是爱情的食粮，那就继续奏下去吧。",
    author: "William Shakespeare《Twelfth Night》",
    source:
      "https://www.folger.edu/explore/shakespeares-works/twelfth-night/read/",
  },
  {
    id: "nietzsche-music",
    topic: "音乐",
    original: "Ohne Musik wäre das Leben ein Irrtum.",
    translation: "没有音乐，生命将是一个错误。",
    author: "Friedrich Nietzsche《Götzen-Dämmerung》",
    source: "https://www.gutenberg.org/cache/epub/52263/pg52263-images.html",
  },
];
function storedJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}
function activeQuotes() {
  const deleted = new Set(storedJson("yuejian-quote-deleted", [])),
    custom = storedJson("yuejian-quote-custom", []);
  return [...BUILTIN_QUOTES.filter((q) => !deleted.has(q.id)), ...custom];
}
function balancedChineseLines(text) {
  const chars = [...text.trim()];
  if (chars.length <= 10) return [chars.join("")];
  const count = Math.ceil(chars.length / 10),
    lines = [];
  let start = 0;
  for (let line = 0; line < count; line++) {
    const remaining = chars.length - start,
      remainingLines = count - line;
    if (remainingLines === 1) {
      lines.push(chars.slice(start).join(""));
      break;
    }
    const ideal = Math.round(remaining / remainingLines),
      low = Math.max(4, ideal - 2),
      high = Math.min(10, ideal + 2);
    let split = ideal;
    for (let distance = 0; distance <= 3; distance++) {
      const candidates = [ideal + distance, ideal - distance];
      const found = candidates.find(
        (pos) =>
          pos >= low &&
          pos <= high &&
          /[，。！？；：、,.!?;:]/.test(chars[start + pos - 1] || ""),
      );
      if (found) {
        split = found;
        break;
      }
    }
    const rest = remaining - split;
    if (rest < 4) split = remaining - 4;
    lines.push(chars.slice(start, start + split).join(""));
    start += split;
  }
  return lines;
}
function displayQuote(quote) {
  const original = document.getElementById("quoteOriginal"),
    isCjk = /[\u3400-\u9fff]/.test(quote.original);
  original.classList.toggle("foreign", !!quote.translation);
  original.classList.toggle("cjk", isCjk);
  if (isCjk)
    original.innerHTML = balancedChineseLines(quote.original)
      .map((line) => '<span class="quote-line">' + escapeHtml(line) + "</span>")
      .join("");
  else original.textContent = quote.original;
  const translation = document.getElementById("quoteTranslation");
  translation.textContent = quote.translation || "";
  translation.hidden = !quote.translation;
  document.getElementById("quoteAuthor").textContent = "— " + quote.author;
}
function showRandomQuote(forceRandom = false) {
  const quotes = activeQuotes();
  if (!quotes.length) {
    document.getElementById("quoteOriginal").textContent = "名言库暂时为空";
    document.getElementById("quoteTranslation").textContent =
      "可以打开名言库添加一句。";
    document.getElementById("quoteAuthor").textContent = "";
    return;
  }
  const pinnedId = forceRandom
      ? ""
      : localStorage.getItem("yuejian-quote-pinned"),
    pinned = quotes.find((q) => q.id === pinnedId);
  if (pinned) {
    displayQuote(pinned);
    return;
  }
  if (pinnedId) localStorage.removeItem("yuejian-quote-pinned");
  const last = localStorage.getItem("yuejian-quote-last"),
    choices = quotes.length > 1 ? quotes.filter((q) => q.id !== last) : quotes,
    quote = choices[Math.floor(Math.random() * choices.length)];
  localStorage.setItem("yuejian-quote-last", quote.id);
  displayQuote(quote);
}
function renderQuoteLibrary() {
  const list = document.getElementById("quoteList"),
    quotes = activeQuotes(),
    pinnedId = localStorage.getItem("yuejian-quote-pinned");
  list.innerHTML = quotes.length
    ? quotes
        .map((q) => {
          const builtin = BUILTIN_QUOTES.some((item) => item.id === q.id),
            source =
              builtin && q.source
                ? '<a class="quote-source-link" href="' +
                  escapeHtml(q.source) +
                  '" target="_blank" rel="noopener">核对出处 ↗</a>'
                : "";
          return (
            '<article class="quote-item"><div class="quote-item-top"><button class="quote-pin ' +
            (q.id === pinnedId ? "active" : "") +
            '" data-pin-id="' +
            escapeHtml(q.id) +
            '">' +
            (q.id === pinnedId ? "正在显示" : "设为首页") +
            '</button><button class="quote-delete" data-quote-id="' +
            escapeHtml(q.id) +
            '">删除</button></div><blockquote>' +
            escapeHtml(q.original) +
            "</blockquote><small>— " +
            escapeHtml(q.author) +
            "</small>" +
            source +
            "</article>"
          );
        })
        .join("")
    : '<div class="library-empty">名言库为空，请在右侧添加一句。</div>';
  document
    .querySelectorAll(".quote-pin")
    .forEach(
      (button) => (button.onclick = () => pinQuote(button.dataset.pinId)),
    );
  document
    .querySelectorAll(".quote-delete")
    .forEach(
      (button) => (button.onclick = () => deleteQuote(button.dataset.quoteId)),
    );
  document.getElementById("resumeRandomQuote").hidden = !pinnedId;
}
function pinQuote(id) {
  localStorage.setItem("yuejian-quote-pinned", id);
  showRandomQuote();
  renderQuoteLibrary();
  showNotice("已将这句名言固定显示在首页。");
}
function deleteQuote(id) {
  const quotes = activeQuotes();
  if (quotes.length <= 1) {
    showNotice("请至少保留一句名言。", true);
    return;
  }
  if (BUILTIN_QUOTES.some((q) => q.id === id)) {
    const deleted = new Set(storedJson("yuejian-quote-deleted", []));
    deleted.add(id);
    localStorage.setItem("yuejian-quote-deleted", JSON.stringify([...deleted]));
  } else {
    localStorage.setItem(
      "yuejian-quote-custom",
      JSON.stringify(
        storedJson("yuejian-quote-custom", []).filter((q) => q.id !== id),
      ),
    );
  }
  if (localStorage.getItem("yuejian-quote-pinned") === id)
    localStorage.removeItem("yuejian-quote-pinned");
  renderQuoteLibrary();
  showRandomQuote();
}
showRandomQuote();
const DEFAULT_CATALOG_SOURCES = [
  {
    id: "builtin-annas",
    name: "安娜的档案",
    url: "https://annas-archive.gl/",
    builtIn: true,
  },
  {
    id: "builtin-zlibrary",
    name: "Z-Library",
    url: "https://zlib.bz/",
    builtIn: true,
  },
];
function savedCustomCatalogSources() {
  const saved = storedJson("yuejian-custom-catalog-sources", []);
  return Array.isArray(saved)
    ? saved.filter(
        (item) =>
          item &&
          item.name &&
          item.url &&
          !DEFAULT_CATALOG_SOURCES.some((base) => base.url === item.url),
      )
    : [];
}
function customCatalogSources() {
  return [...DEFAULT_CATALOG_SOURCES, ...savedCustomCatalogSources()];
}
function renderCustomCatalogSources() {
  const list = document.getElementById("customSourceList"),
    sources = customCatalogSources();
  list.innerHTML = sources
    .map(
      (item) =>
        '<div class="custom-source-item"><a href="' +
        escapeHtml(item.url) +
        '" target="_blank" rel="noopener noreferrer" title="' +
        escapeHtml(item.url) +
        '">' +
        escapeHtml(item.name) +
        " ↗</a>" +
        (item.builtIn
          ? '<span class="custom-source-built-in">内置</span>'
          : '<button class="custom-source-delete" data-source-id="' +
            escapeHtml(item.id) +
            '" aria-label="删除 ' +
            escapeHtml(item.name) +
            '">×</button>') +
        "</div>",
    )
    .join("");
  document
    .querySelectorAll(".custom-source-delete")
    .forEach(
      (button) =>
        (button.onclick = () =>
          deleteCustomCatalogSource(button.dataset.sourceId)),
    );
}
function addCustomCatalogSource() {
  const nameInput = document.getElementById("customSourceName"),
    urlInput = document.getElementById("customSourceUrl"),
    name = nameInput.value.trim(),
    rawUrl = urlInput.value.trim();
  if (!name || !rawUrl) {
    showNotice("请填写网站名称和网页地址。", true);
    return;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    showNotice("网页地址格式不正确，请填写完整的 http 或 https 地址。", true);
    return;
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    showNotice("只允许添加不含账号密码的 http 或 https 网页地址。", true);
    return;
  }
  if (customCatalogSources().some((item) => item.url === parsed.href)) {
    showNotice("这个网页已经添加过了。", true);
    return;
  }
  const saved = savedCustomCatalogSources();
  saved.push({
    id: "source-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    name: name.slice(0, 50),
    url: parsed.href,
  });
  localStorage.setItem(
    "yuejian-custom-catalog-sources",
    JSON.stringify(saved.slice(-30)),
  );
  nameInput.value = "";
  urlInput.value = "";
  renderCustomCatalogSources();
  showNotice("电子书网站链接已保存到本机。");
}
function deleteCustomCatalogSource(id) {
  localStorage.setItem(
    "yuejian-custom-catalog-sources",
    JSON.stringify(
      savedCustomCatalogSources().filter((item) => item.id !== id),
    ),
  );
  renderCustomCatalogSources();
  showNotice("电子书网站链接已删除。");
}
document.getElementById("addCustomSource").onclick = addCustomCatalogSource;
document
  .getElementById("customSourceUrl")
  .addEventListener("keydown", (event) => {
    if (event.key === "Enter") addCustomCatalogSource();
  });
renderCustomCatalogSources();
function updateWikisourceFallback() {
  const query = document.getElementById("catalogQuery").value.trim(),
    link = document.getElementById("wikisourceFallback");
  if (!query) {
    link.removeAttribute("href");
    return;
  }
  link.href =
    "https://zh.wikisource.org/w/index.php?search=" +
    encodeURIComponent(query) +
    "&title=Special%3A%E6%90%9C%E7%B4%A2&ns0=1";
}
document
  .getElementById("catalogQuery")
  .addEventListener("input", updateWikisourceFallback);
updateWikisourceFallback();
let noticeTimer = null;
function showNotice(message, error = false) {
  clearTimeout(noticeTimer);
  notice.classList.remove("hiding");
  notice.textContent = message;
  notice.style.background = error ? "#fce9df" : "#fff4dc";
  notice.style.color = error ? "#8a3624" : "#765525";
  notice.classList.add("show");
  noticeTimer = setTimeout(() => {
    notice.classList.add("hiding");
    setTimeout(() => {
      notice.classList.remove("show", "hiding");
    }, 260);
  }, 10000);
}
function viewShell(active, content) {
  summary.innerHTML =
    '<div class="view-tabs"><button class="view-tab ' +
    (active === "analysis" ? "active" : "") +
    '" id="analysisTab">AI 分析</button><button class="view-tab ' +
    (active === "reader" ? "active" : "") +
    '" id="readerTab">原文阅读</button></div><div id="viewContent">' +
    content +
    "</div>";
  document.getElementById("analysisTab").onclick = showAnalysis;
  document.getElementById("readerTab").onclick = () =>
    loadChapter(currentChapterIndex);
}
function allReadingStats() {
  try {
    return JSON.parse(localStorage.getItem("yuejian-reading-stats") || "{}");
  } catch {
    return {};
  }
}
function allLocalReadingContributions() {
  try {
    return JSON.parse(localStorage.getItem("yuejian-reading-contributions") || "{}");
  } catch {
    return {};
  }
}
function addLocalReadingContribution(bookId, day, seconds, chars) {
  const all = allLocalReadingContributions();
  const book = all[bookId] || { daily: {}, dailyChars: {} };
  book.daily = book.daily || {};
  book.dailyChars = book.dailyChars || {};
  book.daily[day] = (Number(book.daily[day]) || 0) + seconds;
  book.dailyChars[day] = (Number(book.dailyChars[day]) || 0) + chars;
  all[bookId] = book;
  localStorage.setItem("yuejian-reading-contributions", JSON.stringify(all));
}
function allBookProgress() {
  try { return JSON.parse(localStorage.getItem("yuejian-book-progress") || "{}"); }
  catch { return {}; }
}
function saveCurrentBookProgress() {
  if (!currentBookKey || !currentBookData?.chapters?.length) return;
  const all = allBookProgress(), total = Math.max(1, currentBookData.chapters.length - 1);
  all[currentBookKey] = { bookId: currentBookKey, chapter: currentChapterIndex, progress: Math.max(0, Math.min(1, currentChapterIndex / total)), updatedAt: Date.now() };
  localStorage.setItem("yuejian-book-progress", JSON.stringify(all));
}
function bookStats() {
  const all = allReadingStats();
  const value = all[currentBookKey] && typeof all[currentBookKey] === "object" ? all[currentBookKey] : {};
  return {
    ...value,
    seconds: Number(value.seconds) || 0,
    completed: Array.isArray(value.completed) ? value.completed : [],
    daily: value.daily && typeof value.daily === "object" ? value.daily : {},
    dailyChars: value.dailyChars && typeof value.dailyChars === "object" ? value.dailyChars : {},
    sessions: Number(value.sessions) || 0,
  };
}
function saveBookStats(stats) {
  const all = allReadingStats();
  all[currentBookKey] = stats;
  localStorage.setItem("yuejian-reading-stats", JSON.stringify(all));
}
function localDate() {
  return new Date().toISOString().slice(0, 10);
}
function formatReadingTime(seconds) {
  if (seconds < 60) return seconds + "秒";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? minutes + "分钟" : (minutes / 60).toFixed(1) + "小时";
}
function annotationSummary() {
  const all = annotations(),
    prefix = currentBookKey + "::";
  let notes = 0,
    red = 0;
  Object.entries(all).forEach(([key, value]) => {
    if (key.startsWith(prefix)) {
      if (value.note) notes++;
      if (value.red) red++;
    }
  });
  readerMarks().forEach((item) => {
    if (item.book !== currentBookKey) return;
    if (item.note) notes++;
    red++;
  });
  return { notes, red };
}
function guessDomain(title) {
  if (/音乐|艺术|绘画|电影/.test(title)) return "艺术与文化";
  if (/历史|文明|战争/.test(title)) return "历史与社会";
  if (/经济|金融|商业/.test(title)) return "经济与管理";
  if (/科学|物理|生物|技术/.test(title)) return "科学与技术";
  return "综合阅读";
}
function readingDashboardHtml() {
  if (!currentBookData) return "";
  const stats = bookStats(),
    total = currentBookData.chapters.length,
    done = stats.completed.length,
    percent = Math.round((done / Math.max(1, total)) * 100),
    marks = annotationSummary(),
    domain = currentBookData.analysis?.domain,
    primary = domain?.primary || guessDomain(currentBookData.title),
    secondary = domain?.secondary || [],
    difficulty = domain?.difficulty || "未评级",
    estimateSeconds = ((currentBookData.total_chars || 0) / 500) * 60;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10),
      seconds = stats.daily[key] || 0;
    days.push({
      label: ["日", "一", "二", "三", "四", "五", "六"][date.getDay()],
      seconds,
    });
  }
  const max = Math.max(60, ...days.map((x) => x.seconds)),
    bars = days
      .map(
        (day) =>
          '<div class="activity-day"><div class="activity-bar" style="height:' +
          Math.max(4, Math.round((day.seconds / max) * 46)) +
          'px" aria-label="周' +
          day.label +
          "阅读" +
          formatReadingTime(day.seconds) +
          '"></div><small>' +
          day.label +
          "</small></div>",
      )
      .join("");
  return (
    '<section class="reading-dashboard"><div class="dashboard-head"><h3>阅读成果与进展</h3><div class="domain-tags"><span class="domain-tag">' +
    escapeHtml(primary) +
    "</span>" +
    secondary
      .slice(0, 2)
      .map((x) => '<span class="domain-tag">' + escapeHtml(x) + "</span>")
      .join("") +
    '<span class="domain-tag">' +
    escapeHtml(difficulty) +
    '</span></div></div><div class="stats-grid"><div class="stat-card"><span>累计阅读</span><b>' +
    formatReadingTime(stats.seconds) +
    '</b></div><div class="stat-card"><span>已读章节</span><b>' +
    done +
    " / " +
    total +
    '</b></div><div class="stat-card"><span>预计总时长</span><b>' +
    formatReadingTime(estimateSeconds) +
    '</b></div><div class="stat-card"><span>阅读成果</span><b>' +
    marks.notes +
    "批注 · " +
    marks.red +
    '标红</b></div></div><div class="progress-visual"><div class="progress-ring" style="background:conic-gradient(var(--green) ' +
    percent +
    '%, #e5e6dc 0)"><b>' +
    percent +
    '%</b></div><div><div class="activity-title">最近7天阅读时长</div><div class="activity-chart" role="img" aria-label="最近7天阅读活动">' +
    bars +
    "</div></div></div></section>"
  );
}
function showAnalysis() {
  readingActive = false;
  viewShell("analysis", analysisHtml);
  document
    .querySelectorAll(".chapters button")
    .forEach((x) => x.classList.remove("active"));
  document
    .querySelector(".chapters button[data-analysis]")
    ?.classList.add("active");
  const button = document.getElementById("reanalyzeButton");
  if (button) button.onclick = reanalyzeBook;
  const startButton = document.getElementById("startInitialAnalysis");
  if (startButton) startButton.onclick = startInitialAnalysis;
}
function annotations() {
  try {
    return JSON.parse(localStorage.getItem("yuejian-annotations") || "{}");
  } catch {
    return {};
  }
}
function paragraphKey(p) {
  return (
    currentBookKey +
    "::" +
    currentChapterIndex +
    "::" +
    p.dataset.paragraphIndex
  );
}
function saveParagraph(p, changes) {
  const all = annotations(),
    key = paragraphKey(p),
    old = all[key] || {};
  all[key] = { ...old, ...changes };
  if (!all[key].red && !all[key].note) delete all[key];
  localStorage.setItem("yuejian-annotations", JSON.stringify(all));
}
function restoreAnnotations() {
  const all = annotations();
  document.querySelectorAll(".reader-body p").forEach((p, i) => {
    p.dataset.paragraphIndex = i;
    const saved = all[paragraphKey(p)];
    if (saved?.red) p.classList.add("marked-red");
    if (saved?.note) {
      p.classList.add("has-note");
      const note = document.createElement("div");
      note.className = "paragraph-note";
      note.textContent = "批注：" + saved.note;
      p.insertAdjacentElement("afterend", note);
    }
  });
}
function positionSelectionToolbar(selection = window.getSelection()) {
  const toolbar = document.getElementById("selectionToolbar");
  if (!toolbar?.classList.contains("show") || !selection?.rangeCount) return;
  const range = selection.getRangeAt(0),
    visibleRects = [...range.getClientRects()].filter(
      (item) => item.width && item.height && item.bottom > 0 && item.top < innerHeight,
    ),
    rect = visibleRects[visibleRects.length - 1] || range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  requestAnimationFrame(() => {
    const gap = 10,
      edge = 12,
      width = toolbar.offsetWidth,
      height = toolbar.offsetHeight,
      left = Math.min(
        innerWidth - width - edge,
        Math.max(edge, rect.left + rect.width / 2 - width / 2),
      ),
      above = rect.top - height - gap,
      top = above >= edge
        ? above
        : Math.min(innerHeight - height - edge, rect.bottom + gap);
    toolbar.style.left = left + "px";
    toolbar.style.top = Math.max(edge, top) + "px";
  });
}
function locateReaderSelection(selection, quote) {
  if (!selection?.rangeCount || !quote) return null;
  const range = selection.getRangeAt(0),
    anchor = selection.anchorNode?.nodeType === 3
      ? selection.anchorNode.parentElement
      : selection.anchorNode,
    section = anchor?.closest?.(".desktop-continuous-chapter"),
    root = section || document.querySelector(".reader-body"),
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement.closest(
          ".reader-exact-mark,.desktop-chapter-divider,.paragraph-note",
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
  let node,
    text = "",
    start = -1;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) start = text.length + range.startOffset;
    text += node.data;
  }
  if (start < 0) start = text.indexOf(quote);
  const raw = selection.toString(),
    leading = Math.max(0, raw.indexOf(quote));
  start = Math.max(0, start + leading);
  const end = start + quote.length;
  return {
    chapter: section ? Number(section.dataset.chapter) : currentChapterIndex,
    start,
    end,
    prefix: text.slice(Math.max(0, start - 48), start),
    suffix: text.slice(end, end + 48),
  };
}
function selectParagraph(p, text = "", selection = window.getSelection()) {
  document
    .querySelectorAll(".paragraph-selected")
    .forEach((x) => x.classList.remove("paragraph-selected"));
  selectedParagraph = p;
  selectedText = text || p?.textContent?.trim() || "";
  selectedLocator = selectedText ? locateReaderSelection(selection, selectedText) : null;
  p?.classList.add("paragraph-selected");
  const toolbar = document.getElementById("selectionToolbar");
  if (toolbar) {
    toolbar.classList.toggle("show", !!selectedText);
    if (selectedText) positionSelectionToolbar(selection);
  }
}
const readerFonts = {
  serif: 'Georgia, "Songti SC", SimSun, serif',
  yahei: '"Microsoft YaHei", "PingFang SC", sans-serif',
  kaiti: "KaiTi, STKaiti, serif",
  heiti: 'SimHei, "Microsoft YaHei", sans-serif',
};
function applyReaderTypography() {
  const fontKey = localStorage.getItem("yuejian-reader-font") || "serif",
    size = Math.min(
      30,
      Math.max(
        14,
        Number(localStorage.getItem("yuejian-reader-font-size")) || 17,
      ),
    );
  document.documentElement.style.setProperty(
    "--reader-font",
    readerFonts[fontKey] || readerFonts.serif,
  );
  document.documentElement.style.setProperty("--reader-font-size", size + "px");
  const font = document.getElementById("readerFont"),
    range = document.getElementById("readerFontSize"),
    value = document.getElementById("readerSizeValue");
  if (font) font.value = readerFonts[fontKey] ? fontKey : "serif";
  if (range) range.value = size;
  if (value) value.textContent = size + " px";
}
function initReaderTypography() {
  applyReaderTypography();
  const font = document.getElementById("readerFont"),
    range = document.getElementById("readerFontSize");
  font.onchange = () => {
    localStorage.setItem("yuejian-reader-font", font.value);
    applyReaderTypography();
  };
  range.oninput = () => {
    localStorage.setItem("yuejian-reader-font-size", range.value);
    applyReaderTypography();
  };
}
function updateNoteDisplay(p, noteText) {
  p.nextElementSibling?.classList.contains("paragraph-note") &&
    p.nextElementSibling.remove();
  if (noteText) {
    const note = document.createElement("div");
    note.className = "paragraph-note";
    note.textContent = "批注：" + noteText;
    p.insertAdjacentElement("afterend", note);
  }
}
function readerMarks() {
  try {
    return JSON.parse(localStorage.getItem("yuejian-reader-marks") || "[]");
  } catch {
    return [];
  }
}
function saveReaderMarks(items) {
  localStorage.setItem("yuejian-reader-marks", JSON.stringify(items));
}
function applyReaderMark(root, item) {
  const nodes = [],
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement.closest(".reader-exact-mark,.desktop-chapter-divider,.paragraph-note")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
  let node,
    text = "";
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: text.length, end: text.length + node.data.length });
    text += node.data;
  }
  let at =
    Number.isInteger(item.start) &&
    item.start >= 0 &&
    text.slice(item.start, item.start + item.quote.length) === item.quote
      ? item.start
      : -1;
  if (at < 0 && item.prefix) {
    const probe = item.prefix + item.quote + (item.suffix || ""),
      found = text.indexOf(probe);
    if (found >= 0) at = found + item.prefix.length;
  }
  if (at < 0) at = text.indexOf(item.quote);
  if (at < 0) return;
  const end = at + item.quote.length;
  nodes
    .filter((entry) => entry.end > at && entry.start < end)
    .reverse()
    .forEach((entry) => {
      const range = document.createRange(),
        from = Math.max(0, at - entry.start),
        to = Math.min(entry.node.data.length, end - entry.start),
        mark = document.createElement("mark");
      range.setStart(entry.node, from);
      range.setEnd(entry.node, to);
      mark.className = "reader-exact-mark " + (item.color || "amber");
      mark.dataset.readerMark = item.id;
      range.surroundContents(mark);
    });
}
function restoreExactMarks(root = document.querySelector(".reader-body"), chapter = currentChapterIndex) {
  if (!root) return;
  root.querySelectorAll(".reader-exact-mark").forEach((mark) => mark.replaceWith(...mark.childNodes));
  readerMarks()
    .filter((item) => item.book === currentBookKey && item.chapter === chapter)
    .forEach((item) => applyReaderMark(root, item));
}
function ensureAnnotationSheet() {
  if (document.getElementById("desktopAnnotationSheet")) return;
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div class="desktop-annotation-sheet" id="desktopAnnotationSheet"><div class="desktop-annotation-card"><div class="desktop-annotation-head"><div><h3 id="desktopAnnotationTitle">添加批注</h3><p id="desktopAnnotationQuote"></p></div><button id="desktopAnnotationClose">×</button></div><textarea id="desktopAnnotationText" placeholder="写下你的理解、疑问或联想…"></textarea><div class="desktop-annotation-colors"><button data-mark-color="amber">黄色</button><button data-mark-color="red">红色</button><button data-mark-color="blue">蓝色</button><button data-mark-color="green">绿色</button></div><div class="desktop-annotation-list" id="desktopAnnotationList"></div><div class="desktop-annotation-actions"><button class="danger" id="desktopAnnotationDelete">删除标记</button><button class="save" id="desktopAnnotationSave">保存</button></div></div></div>',
  );
  document.getElementById("desktopAnnotationClose").onclick = closeDesktopAnnotation;
  document.getElementById("desktopAnnotationSave").onclick = saveDesktopAnnotation;
  document.getElementById("desktopAnnotationDelete").onclick = deleteDesktopAnnotation;
  document.querySelectorAll("[data-mark-color]").forEach(
    (button) =>
      (button.onclick = () => {
        desktopAnnotationColor = button.dataset.markColor;
        updateDesktopAnnotationColors();
      }),
  );
}
let desktopEditingMark = null,
  desktopAnnotationColor = "amber";
function updateDesktopAnnotationColors() {
  document.querySelectorAll("[data-mark-color]").forEach((button) =>
    button.classList.toggle("active", button.dataset.markColor === desktopAnnotationColor),
  );
}
function openDesktopAnnotation(item = null) {
  ensureAnnotationSheet();
  desktopEditingMark = item;
  desktopAnnotationColor = item?.color || "amber";
  document.getElementById("desktopAnnotationTitle").textContent = item ? "编辑阅读标记" : "添加精确批注";
  document.getElementById("desktopAnnotationQuote").textContent = item?.quote || selectedText;
  document.getElementById("desktopAnnotationText").value = item?.note || "";
  document.getElementById("desktopAnnotationDelete").hidden = !item;
  document.getElementById("desktopAnnotationList").hidden = true;
  document.getElementById("desktopAnnotationText").hidden = false;
  document.querySelector(".desktop-annotation-colors").hidden = false;
  document.querySelector(".desktop-annotation-actions").hidden = false;
  updateDesktopAnnotationColors();
  document.getElementById("desktopAnnotationSheet").classList.add("open");
  setTimeout(() => document.getElementById("desktopAnnotationText").focus(), 60);
}
function closeDesktopAnnotation() {
  document.getElementById("desktopAnnotationSheet")?.classList.remove("open");
  desktopEditingMark = null;
}
function saveDesktopAnnotation() {
  const quote = desktopEditingMark?.quote || selectedText;
  if (!quote) return;
  const items = readerMarks(),
    now = Date.now(),
    saved = {
      id: desktopEditingMark?.id || "mark-" + now.toString(36) + Math.random().toString(36).slice(2),
      book: currentBookKey,
      chapter: desktopEditingMark?.chapter ?? selectedLocator?.chapter ?? currentChapterIndex,
      quote,
      note: document.getElementById("desktopAnnotationText").value.trim(),
      color: desktopAnnotationColor,
      created: desktopEditingMark?.created || now,
      updated: now,
      start: desktopEditingMark?.start ?? selectedLocator?.start ?? -1,
      end: desktopEditingMark?.end ?? selectedLocator?.end ?? -1,
      prefix: desktopEditingMark?.prefix ?? selectedLocator?.prefix ?? "",
      suffix: desktopEditingMark?.suffix ?? selectedLocator?.suffix ?? "",
    },
    index = items.findIndex((item) => item.id === saved.id);
  if (index >= 0) items[index] = saved;
  else items.push(saved);
  saveReaderMarks(items);
  closeDesktopAnnotation();
  restoreExactMarks();
  selectParagraph(null, "");
  showNotice("阅读标记已保存。");
}
function deleteDesktopAnnotation() {
  if (!desktopEditingMark) return;
  saveReaderMarks(readerMarks().filter((item) => item.id !== desktopEditingMark.id));
  closeDesktopAnnotation();
  restoreExactMarks();
  showNotice("批注或高亮已删除。");
}
function saveExactHighlight(color) {
  if (!selectedText) return;
  desktopAnnotationColor = color;
  const now = Date.now(),
    items = readerMarks();
  items.push({ id: "mark-" + now.toString(36) + Math.random().toString(36).slice(2), book: currentBookKey, chapter: selectedLocator?.chapter ?? currentChapterIndex, quote: selectedText, note: "", color, created: now, updated: now, start: selectedLocator?.start ?? -1, end: selectedLocator?.end ?? -1, prefix: selectedLocator?.prefix ?? "", suffix: selectedLocator?.suffix ?? "" });
  saveReaderMarks(items);
  restoreExactMarks();
  window.getSelection().removeAllRanges();
  selectParagraph(null, "");
}
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
}
function desktopChapterTitle(chapter = selectedLocator?.chapter ?? currentChapterIndex) {
  const value = currentBookData?.chapters?.[chapter];
  return typeof value === "string" ? value : value?.title || `第 ${chapter + 1} 章`;
}
async function copyDesktopSelection() {
  if (!selectedText) return;
  await copyTextToClipboard(selectedText);
  showNotice("选中文字已复制。");
}
const desktopBookmarkPalettes = {
  starry: { top: "#06142f", bottom: "#173a78", card: "rgba(10,29,67,.84)", ink: "#f4f7ff", muted: "#b8c8ea", accent: "#86b5ff", glow: "#f6d376" },
  cat: { top: "#f6dfcf", bottom: "#d99c92", card: "rgba(255,248,239,.88)", ink: "#503632", muted: "#87645d", accent: "#b86d70", glow: "#fff3d3" },
  night: { top: "#11151f", bottom: "#283044", card: "rgba(22,27,39,.9)", ink: "#f1eee8", muted: "#b5b0a8", accent: "#cba47d", glow: "#dbc893" },
  blue: { top: "#dcecf6", bottom: "#7ca8c8", card: "rgba(246,251,255,.88)", ink: "#253c4d", muted: "#5d7483", accent: "#477c9d", glow: "#eff8ff" },
  sepia: { top: "#efe1c5", bottom: "#b88e5f", card: "rgba(255,249,235,.88)", ink: "#4c3927", muted: "#78624b", accent: "#9a6c3e", glow: "#fff2c9" },
  paper: { top: "#f3eee5", bottom: "#c9bba7", card: "rgba(255,253,248,.9)", ink: "#342f2a", muted: "#71685f", accent: "#7b6654", glow: "#fffdf3" }
};
let desktopBookmarkPreview = null;
function bookmarkPalette() {
  return desktopBookmarkPalettes[document.body.dataset.theme] || desktopBookmarkPalettes.paper;
}
function canvasRoundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath(); context.moveTo(x + r, y); context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r); context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r); context.closePath();
}
function canvasTextLines(context, text, maxWidth, maxLines) {
  const chars = Array.from(String(text || "").replace(/\s+/g, " ").trim()), lines = [];
  let line = "";
  for (const char of chars) {
    if (context.measureText(line + char).width <= maxWidth || !line) line += char;
    else { lines.push(line); line = char; if (lines.length === maxLines) break; }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.join("").length < chars.length && lines.length) {
    let last = lines[lines.length - 1];
    while (last && context.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last.replace(/[，。；、,.!?！？\s]+$/, "") + "…";
  }
  return lines;
}
function createBookmarkImage(item) {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d"), palette = bookmarkPalette();
  canvas.width = 900; canvas.height = 1200;
  const gradient = ctx.createLinearGradient(0, 0, 900, 1200); gradient.addColorStop(0, palette.top); gradient.addColorStop(1, palette.bottom);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 900, 1200);
  ctx.globalAlpha = .24; ctx.strokeStyle = palette.glow; ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(770, 95, 72 + i * 22, Math.PI * .72, Math.PI * 1.76); ctx.stroke(); }
  [[95,110,7],[145,185,4],[790,300,6],[110,1020,5],[805,1090,8]].forEach(([x,y,r]) => { ctx.fillStyle = palette.glow; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); });
  ctx.globalAlpha = 1; ctx.fillStyle = palette.card; canvasRoundedRect(ctx, 58, 170, 784, 840, 42); ctx.fill();
  ctx.fillStyle = palette.accent; ctx.font = "700 26px 'Microsoft YaHei', sans-serif"; ctx.letterSpacing = "4px"; ctx.fillText("阅见 · 阅读书签", 105, 235);
  ctx.fillStyle = palette.ink; const length = Array.from(item.quote).length, size = length > 260 ? 32 : length > 150 ? 37 : length > 80 ? 43 : 49;
  ctx.font = `600 ${size}px Georgia, 'Noto Serif SC', 'Songti SC', serif`;
  const lines = canvasTextLines(ctx, `“${item.quote}”`, 690, 12), lineHeight = Math.round(size * 1.65), quoteHeight = lines.length * lineHeight;
  let y = Math.max(350, 560 - quoteHeight / 2);
  lines.forEach(line => { ctx.fillText(line, 105, y); y += lineHeight; });
  ctx.strokeStyle = palette.accent; ctx.globalAlpha = .55; ctx.beginPath(); ctx.moveTo(105, 850); ctx.lineTo(795, 850); ctx.stroke(); ctx.globalAlpha = 1;
  ctx.fillStyle = palette.ink; ctx.font = "700 28px 'Microsoft YaHei', sans-serif"; ctx.fillText(`《${String(item.title).slice(0, 28)}》`, 105, 910);
  ctx.fillStyle = palette.muted; ctx.font = "400 22px 'Microsoft YaHei', sans-serif"; ctx.fillText(String(item.chapterTitle || "阅读摘录").slice(0, 36), 105, 952);
  ctx.font = "400 20px 'Microsoft YaHei', sans-serif"; ctx.fillText(item.stamp, 105, 985);
  ctx.fillStyle = palette.ink; ctx.font = "600 23px 'Microsoft YaHei', sans-serif"; ctx.fillText("在字里行间，遇见更辽阔的世界", 105, 1094);
  ctx.fillStyle = palette.accent; ctx.font = "700 24px Georgia, serif"; ctx.textAlign = "right"; ctx.fillText("YUEJIAN", 795, 1094); ctx.textAlign = "left";
  return canvas.toDataURL("image/png");
}
function ensureBookmarkPreviewModal() {
  if (document.getElementById("bookmarkPreviewModal")) return;
  document.body.insertAdjacentHTML("beforeend", `<div id="bookmarkPreviewModal" class="bookmark-preview-modal" aria-hidden="true"><section class="bookmark-preview-card" role="dialog" aria-modal="true" aria-labelledby="bookmarkPreviewTitle"><header><div><span>分享书签</span><h2 id="bookmarkPreviewTitle">图片已生成</h2></div><button id="bookmarkPreviewClose" aria-label="关闭">×</button></header><div class="bookmark-preview-image"><img id="bookmarkPreviewImage" alt="阅读书签图片预览"></div><p>书签颜色已跟随当前阅读主题。确认后将保存为 PNG 图片。</p><footer><button id="bookmarkPreviewCancel">暂不保存</button><button id="bookmarkPreviewSave" class="primary">保存到本地</button></footer></section></div>`);
  const modal = document.getElementById("bookmarkPreviewModal"), close = () => { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); desktopBookmarkPreview = null; };
  document.getElementById("bookmarkPreviewClose").onclick = close; document.getElementById("bookmarkPreviewCancel").onclick = close;
  modal.onclick = event => { if (event.target === modal) close(); };
  document.getElementById("bookmarkPreviewSave").onclick = async event => {
    if (!desktopBookmarkPreview) return;
    const button = event.currentTarget; button.disabled = true; button.textContent = "正在保存…";
    try {
      const response = await fetch("/api/bookmark-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: desktopBookmarkPreview.image, filename: desktopBookmarkPreview.filename }) }), data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      close(); showNotice(`书签图片已保存：${data.path}`);
    } catch (error) { showNotice(error.message || "书签图片保存失败。", true); }
    finally { button.disabled = false; button.textContent = "保存到本地"; }
  };
}
async function shareDesktopSelection() {
  if (!selectedText) return;
  const chapter = selectedLocator?.chapter ?? currentChapterIndex,
    created = Date.now(),
    stamp = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(created)),
    item = { id: "share-" + created.toString(36), book: currentBookKey, title: currentBookData?.title || "未命名书籍", chapter, chapterTitle: desktopChapterTitle(chapter), quote: selectedText, created, stamp };
  let items = [];
  try {
    const saved = JSON.parse(localStorage.getItem("yuejian-share-bookmarks") || "[]");
    if (Array.isArray(saved)) items = saved;
  } catch {}
  items.unshift(item);
  localStorage.setItem("yuejian-share-bookmarks", JSON.stringify(items.slice(0, 300)));
  ensureBookmarkPreviewModal();
  desktopBookmarkPreview = { image: createBookmarkImage(item), filename: `${item.title}-阅读书签-${new Date(created).toISOString().slice(0, 10)}.png` };
  document.getElementById("bookmarkPreviewImage").src = desktopBookmarkPreview.image;
  const modal = document.getElementById("bookmarkPreviewModal"); modal.classList.add("open"); modal.setAttribute("aria-hidden", "false");
}
function selectWholeDesktopParagraph() {
  const selection = window.getSelection(),
    liveNode = selection.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null,
    element = liveNode?.nodeType === 3 ? liveNode.parentElement : liveNode,
    block = element?.closest?.("p,li,blockquote,h1,h2,h3,h4,h5,h6,figcaption,td,th") || selectedParagraph;
  if (!block || !document.querySelector(".reader-body")?.contains(block)) return showNotice("当前位置没有可全选的段落。", true);
  const range = document.createRange();
  range.selectNodeContents(block); selection.removeAllRanges(); selection.addRange(range);
  selectParagraph(block, selection.toString().trim(), selection);
}
async function translateDesktopSelection() {
  if (!selectedText) return;
  const text = selectedText;
  showDesktopTranslationResult("快速翻译", "正在连接基础翻译服务…", "只会发送当前选中的文字，不会上传整本书。", true);
  try {
    const response = await fetch("/api/translate/basic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || "翻译失败");
    showDesktopTranslationResult("快速翻译", data.translation, `${data.provider || "MyMemory"}${data.cached ? " · 本地缓存" : " · 联网结果"}`);
  } catch (error) {
    showDesktopTranslationResult("暂时无法翻译", error.message, "可检查网络后重试，或改用 AI 翻译。", false, true);
  }
}
function ensureDesktopTranslationResult() {
  if (document.getElementById("desktopTranslationResult")) return;
  document.body.insertAdjacentHTML("beforeend", `<div class="translation-result-sheet" id="desktopTranslationResult" aria-hidden="true"><section><header><div><small id="desktopTranslationMeta">阅读页内翻译</small><h2 id="desktopTranslationTitle">翻译结果</h2></div><button type="button" id="closeDesktopTranslationResult" aria-label="关闭">×</button></header><div class="translation-result-body" id="desktopTranslationBody"></div><footer><button type="button" id="copyDesktopTranslation">复制译文</button><button type="button" class="primary" id="doneDesktopTranslation">继续阅读</button></footer></section></div>`);
  const sheet=document.getElementById("desktopTranslationResult"),close=()=>{sheet.classList.remove("open");sheet.setAttribute("aria-hidden","true")};
  document.getElementById("closeDesktopTranslationResult").onclick=close;document.getElementById("doneDesktopTranslation").onclick=close;sheet.addEventListener("click",event=>{if(event.target===sheet)close()});
  document.getElementById("copyDesktopTranslation").onclick=()=>copyTextToClipboard(document.getElementById("desktopTranslationBody").textContent||"");
}
function showDesktopTranslationResult(title,text,meta="阅读页内翻译",loading=false,error=false){
  ensureDesktopTranslationResult();const sheet=document.getElementById("desktopTranslationResult"),body=document.getElementById("desktopTranslationBody");
  document.getElementById("desktopTranslationTitle").textContent=title;document.getElementById("desktopTranslationMeta").textContent=meta;body.textContent=text||"";body.classList.toggle("loading",loading);body.classList.toggle("error",error);sheet.classList.add("open");sheet.setAttribute("aria-hidden","false");
}
function ensureDesktopAiTranslationModal() {
  if (document.getElementById("desktopAiTranslationModal")) return;
  document.body.insertAdjacentHTML("beforeend", `<div class="ai-translation-modal" id="desktopAiTranslationModal" aria-hidden="true"><section><header><div><small>AI 高级翻译</small><h2>告诉 AI 你希望怎样翻译</h2></div><button type="button" id="closeDesktopAiTranslation" aria-label="关闭">×</button></header><div class="translation-presets"><button type="button" data-translation-preset="准确自然，保留专名与术语">准确自然</button><button type="button" data-translation-preset="采用文学化表达，保留原文节奏和意象">文学表达</button><button type="button" data-translation-preset="逐句直译，并在每句后简要解释难词">逐句解释</button><button type="button" data-translation-preset="采用严谨的学术中文，保留专业术语">学术风格</button></div><label>自然语言要求<textarea id="desktopTranslationRequirement" maxlength="300" placeholder="例如：译成自然的中文，保留音乐史术语，并解释拉丁文名称"></textarea></label><p>AI 翻译会使用“AI 设置”中的服务商与模型，并消耗相应 API 额度。</p><footer><button type="button" id="cancelDesktopAiTranslation">取消</button><button type="button" class="primary" id="runDesktopAiTranslation">开始 AI 翻译</button></footer></section></div>`);
  const modal = document.getElementById("desktopAiTranslationModal"), input = document.getElementById("desktopTranslationRequirement");
  modal.querySelectorAll("[data-translation-preset]").forEach((button) => button.onclick = () => { input.value = button.dataset.translationPreset; input.focus(); });
  const close = () => { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); };
  document.getElementById("closeDesktopAiTranslation").onclick = close;
  document.getElementById("cancelDesktopAiTranslation").onclick = close;
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  document.getElementById("runDesktopAiTranslation").onclick = async () => {
    const text = modal.dataset.text || "", requirement = input.value.trim(), button = document.getElementById("runDesktopAiTranslation");
    if (!text) return close();
    button.disabled = true; button.textContent = "正在翻译…"; close();
    showDesktopTranslationResult("AI 正在按要求翻译…", requirement || "准确、自然，保留原文语气与专名", "将使用当前 AI 模型", true);
    try {
      const response = await fetch("/api/translate/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, requirement }) }), data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI 翻译失败");
      showDesktopTranslationResult("AI 高级翻译", data.translation, data.provider || "AI");
    } catch (error) { showDesktopTranslationResult("AI 翻译失败", error.message, "请检查 AI 设置或接口额度", false, true); }
    finally { button.disabled = false; button.textContent = "开始 AI 翻译"; }
  };
}
function openDesktopAiTranslation() {
  if (!selectedText) return;
  ensureDesktopAiTranslationModal();
  const modal = document.getElementById("desktopAiTranslationModal");
  modal.dataset.text = selectedText; modal.classList.add("open"); modal.setAttribute("aria-hidden", "false");
  setTimeout(() => document.getElementById("desktopTranslationRequirement").focus(), 30);
}
function openDesktopAnnotationList() {
  ensureAnnotationSheet();
  const items = readerMarks().filter((item) => item.book === currentBookKey && item.chapter === currentChapterIndex),
    list = document.getElementById("desktopAnnotationList");
  document.getElementById("desktopAnnotationTitle").textContent = "本章批注与高亮";
  document.getElementById("desktopAnnotationQuote").textContent = "共 " + items.length + " 条，可点击修改或删除";
  document.getElementById("desktopAnnotationText").hidden = true;
  document.querySelector(".desktop-annotation-colors").hidden = true;
  document.querySelector(".desktop-annotation-actions").hidden = true;
  list.hidden = false;
  list.innerHTML = items.length
    ? items.map((item) => '<button data-edit-mark="' + item.id + '"><i class="' + item.color + '"></i><span>' + escapeHtml(item.quote.slice(0, 90)) + '<small>' + escapeHtml(item.note || "仅高亮") + "</small></span></button>").join("")
    : "<p>本章还没有标记。直接拖选文字即可批注或高亮。</p>";
  list.onclick = (event) => {
    const button = event.target.closest("[data-edit-mark]");
    if (button) openDesktopAnnotation(items.find((item) => item.id === button.dataset.editMark));
  };
  document.getElementById("desktopAnnotationSheet").classList.add("open");
}
function initReaderTools() {
  const reader = document.querySelector(".reader-body");
  const toolbar = document.getElementById("selectionToolbar");
  document.querySelectorAll("body > #selectionToolbar").forEach((old) => old.remove());
  document.body.appendChild(toolbar);
  initReaderTypography();
  restoreExactMarks(reader, currentChapterIndex);
  reader.addEventListener("click", (event) => {
    const mark = event.target.closest("[data-reader-mark]");
    if (mark) openDesktopAnnotation(readerMarks().find((item) => item.id === mark.dataset.readerMark));
  });
  const showToolsForSelection = () => {
    const selection = window.getSelection(),
      text = selection.toString().trim();
    if (!text) return;
    const node = selection.rangeCount
        ? selection.getRangeAt(0).commonAncestorContainer
        : null,
      p = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.("p");
    if (!reader.contains(node)) return;
    selectParagraph(p || selectedParagraph, text, selection);
  };
  reader.addEventListener("mouseup", showToolsForSelection);
  reader.addEventListener("keyup", showToolsForSelection);
  reader.addEventListener("touchend", () => setTimeout(showToolsForSelection, 40), {
    passive: true,
  });
  document.getElementById("markAmber").onclick = () => saveExactHighlight("amber");
  document.getElementById("markRed").onclick = () => saveExactHighlight("red");
  document.getElementById("markBlue").onclick = () => saveExactHighlight("blue");
  document.getElementById("markGreen").onclick = () => saveExactHighlight("green");
  document.getElementById("addNote").onclick = () => selectedText && openDesktopAnnotation();
  document.getElementById("copySelection").onclick = copyDesktopSelection;
  document.getElementById("shareSelection").onclick = shareDesktopSelection;
  document.getElementById("selectParagraph").onclick = selectWholeDesktopParagraph;
  document.getElementById("translateSelection").onclick = translateDesktopSelection;
  document.getElementById("aiTranslateSelection").onclick = openDesktopAiTranslation;
  document.getElementById("manageAnnotations").onclick = openDesktopAnnotationList;
  document.getElementById("aiExplain").onclick = explainSelection;
  document.getElementById("clearSelection").onclick = () =>
    selectParagraph(null, "");
}
async function explainSelection() {
  if (!selectedText) return;
  answer.innerHTML =
    "<b>正在解析选段…</b>" + escapeHtml(selectedText.slice(0, 120));
  try {
    const response = await fetch("/api/question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        question:
          "请解释下面这段原文的含义、背景及其在本章中的作用：\n" + selectedText,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "解析失败");
    answer.innerHTML =
      "<b>选段解析</b>" + escapeHtml(data.answer).replace(/\n/g, "<br>");
  } catch (error) {
    answer.innerHTML = "<b>暂时无法解析</b>" + escapeHtml(error.message);
  }
}
function ensureReadingTimer() {
  if (readingTimer) return;
  readingTimer = setInterval(() => {
    if (!readingActive || document.hidden || !currentBookKey) return;
    const stats = bookStats(),
      today = reportDateKey();
    stats.seconds = (stats.seconds || 0) + 5;
    stats.daily = stats.daily || {};
    stats.dailyChars = stats.dailyChars || {};
    stats.daily[today] = (stats.daily[today] || 0) + 5;
    stats.dailyChars[today] = (stats.dailyChars[today] || 0) + 42;
    addLocalReadingContribution(currentBookKey, today, 5, 42);
    saveBookStats(stats);
  }, 5000);
}
function updateCompleteButton() {
  const button = document.getElementById("chapterComplete"),
    done = bookStats().completed.includes(currentChapterIndex);
  if (button) {
    button.textContent = done ? "✓ 本章已读" : "标记本章已读";
    button.classList.toggle("done", done);
  }
}
function toggleChapterComplete() {
  const stats = bookStats(),
    set = new Set(stats.completed || []);
  set.has(currentChapterIndex)
    ? set.delete(currentChapterIndex)
    : set.add(currentChapterIndex);
  stats.completed = [...set].sort((a, b) => a - b);
  saveBookStats(stats);
  updateCompleteButton();
}
let desktopReaderFlow = localStorage.getItem("yuejian-desktop-reader-flow") || "scroll",
  desktopPageIndex = 0,
  desktopPageCount = 1,
  desktopPageStep = 1,
  desktopLoadedFrom = 0,
  desktopLoadedThrough = 0,
  desktopAppendLoading = false,
  desktopPrependLoading = false,
  desktopChapterObserver = null,
  desktopPageResizeObserver = null;
function desktopChapterSection(index, data, nodes = null) {
  const section = document.createElement("section");
  section.className = "desktop-continuous-chapter";
  section.dataset.chapter = index;
  section.innerHTML = '<div class="desktop-chapter-divider"><span>' + (index + 1) + " / " + currentBookData.chapters.length + "</span><strong>" + escapeHtml(data?.title || currentBookData.chapters[index]) + "</strong></div>";
  if (nodes) section.append(...nodes);
  else {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = data.html;
    section.append(...wrapper.childNodes);
  }
  restoreExactMarks(section, index);
  return section;
}
async function appendDesktopChapter() {
  if (desktopAppendLoading || desktopLoadedThrough >= currentBookData.chapters.length - 1) return;
  desktopAppendLoading = true;
  try {
    const next = desktopLoadedThrough + 1,
      response = await fetch("/api/chapter?session_id=" + encodeURIComponent(sessionId) + "&index=" + next),
      data = await response.json();
    if (!response.ok) return;
    const body = document.querySelector(".reader-body"),
      sentinel = body.querySelector(".desktop-chapter-sentinel");
    body.insertBefore(desktopChapterSection(next, data), sentinel);
    desktopLoadedThrough = next;
  } finally {
    desktopAppendLoading = false;
  }
}
async function prependDesktopChapter() {
  if (desktopPrependLoading || desktopLoadedFrom <= 0) return;
  desktopPrependLoading = true;
  try {
    const previous = desktopLoadedFrom - 1,
      oldHeight = document.documentElement.scrollHeight,
      response = await fetch("/api/chapter?session_id=" + encodeURIComponent(sessionId) + "&index=" + previous),
      data = await response.json();
    if (response.ok) {
      const body = document.querySelector(".reader-body"), top = body.querySelector(".desktop-chapter-sentinel.top");
      top.insertAdjacentElement("afterend", desktopChapterSection(previous, data));
      desktopLoadedFrom = previous;
      window.scrollBy(0, document.documentElement.scrollHeight - oldHeight);
    }
  } finally {
    desktopPrependLoading = false;
  }
}
function updateDesktopVisibleChapter() {
  const sections = [...document.querySelectorAll(".desktop-continuous-chapter")],
    visible = sections.find((section) => {
      const rect = section.getBoundingClientRect();
      return rect.bottom > 180 && rect.top < innerHeight * 0.55;
    });
  if (!visible) return;
  const index = Number(visible.dataset.chapter);
  if (index !== currentChapterIndex) {
    currentChapterIndex = index;
    saveCurrentBookProgress();
    document.querySelector(".reader-head h2").textContent = desktopChapterTitle(index);
    document.querySelector(".toc-label").textContent = "第 " + (index + 1) + " / " + currentBookData.chapters.length + " 章";
    document.getElementById("prevChapter").disabled = index === 0;
    document.getElementById("nextChapter").disabled = index === currentBookData.chapters.length - 1;
    document.querySelectorAll(".chapters button").forEach((button) => button.classList.remove("active"));
    const active = document.querySelector('.chapters button[data-index="' + index + '"]');
    active?.classList.add("active"); active?.scrollIntoView({ block: "nearest" });
    updateCompleteButton();
  }
}
function setupDesktopReadingFlow(data) {
  const select = document.getElementById("desktopReaderFlow"),
    body = document.querySelector(".reader-body");
  select.value = desktopReaderFlow;
  select.onchange = () => {
    desktopReaderFlow = select.value;
    localStorage.setItem("yuejian-desktop-reader-flow", desktopReaderFlow);
    loadChapter(currentChapterIndex);
  };
  if (desktopReaderFlow === "page") {
    const viewport = document.createElement("div");
    viewport.className = "desktop-page-viewport";
    body.parentNode.insertBefore(viewport, body);
    viewport.appendChild(body);
    body.classList.add("desktop-page-mode");
    desktopPageIndex = 0;
    const layoutPages = () => {
      const gap = 42,
        width = Math.max(320, viewport.clientWidth);
      body.style.width = width + "px";
      body.style.columnWidth = width + "px";
      body.style.columnGap = gap + "px";
      desktopPageStep = width + gap;
      desktopPageCount = Math.max(
        1,
        Math.ceil((body.scrollWidth + gap) / desktopPageStep),
      );
      desktopPageIndex = Math.min(desktopPageIndex, desktopPageCount - 1);
      updateDesktopPage(false);
    };
    requestAnimationFrame(layoutPages);
    desktopPageResizeObserver?.disconnect();
    desktopPageResizeObserver = new ResizeObserver(layoutPages);
    desktopPageResizeObserver.observe(viewport);
    document.getElementById("prevChapter").onclick = () => turnDesktopPage(-1);
    document.getElementById("nextChapter").onclick = () => turnDesktopPage(1);
    return;
  }
  const currentNodes = [...body.childNodes];
  body.replaceChildren(desktopChapterSection(data.index, data, currentNodes));
  desktopLoadedFrom = data.index; desktopLoadedThrough = data.index;
  const topSentinel = document.createElement("div"), sentinel = document.createElement("div");
  topSentinel.className = "desktop-chapter-sentinel top";
  topSentinel.textContent = data.index > 0 ? "继续向上阅读上一章" : "已到全书开头";
  sentinel.className = "desktop-chapter-sentinel bottom";
  sentinel.textContent = data.index < data.total - 1 ? "正在准备下一章…" : "已读到全书末尾";
  body.prepend(topSentinel); body.append(sentinel);
  desktopChapterObserver?.disconnect();
  desktopChapterObserver = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target.classList.contains("top")) {
        await prependDesktopChapter();
        topSentinel.textContent = desktopLoadedFrom > 0 ? "继续向上阅读上一章" : "已到全书开头";
      } else {
        await appendDesktopChapter();
        sentinel.textContent = desktopLoadedThrough < data.total - 1 ? "继续向下阅读" : "已读到全书末尾";
      }
    }
  }, { rootMargin: "700px 0px" });
  desktopChapterObserver.observe(topSentinel); desktopChapterObserver.observe(sentinel);
  window.removeEventListener("scroll", updateDesktopVisibleChapter);
  window.addEventListener("scroll", updateDesktopVisibleChapter, { passive: true });
  prependDesktopChapter(); appendDesktopChapter();
  document.getElementById("prevChapter").onclick = async () => {
    let target = document.querySelector('.desktop-continuous-chapter[data-chapter="' + (currentChapterIndex - 1) + '"]');
    if (!target) { await prependDesktopChapter(); target = document.querySelector('.desktop-continuous-chapter[data-chapter="' + (currentChapterIndex - 1) + '"]'); }
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  document.getElementById("nextChapter").onclick = async () => {
    let target = document.querySelector('.desktop-continuous-chapter[data-chapter="' + (currentChapterIndex + 1) + '"]');
    if (!target) { await appendDesktopChapter(); target = document.querySelector('.desktop-continuous-chapter[data-chapter="' + (currentChapterIndex + 1) + '"]'); }
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
}
function updateDesktopPage(smooth = true) {
  const viewport = document.querySelector(".desktop-page-viewport");
  viewport?.scrollTo({
    left: desktopPageIndex * desktopPageStep,
    behavior: smooth ? "smooth" : "auto",
  });
  document.querySelector(".toc-label").textContent = "第 " + (currentChapterIndex + 1) + " / " + currentBookData.chapters.length + " 章 · 第 " + (desktopPageIndex + 1) + " / " + desktopPageCount + " 页";
}
async function turnDesktopPage(direction) {
  if (direction > 0 && desktopPageIndex < desktopPageCount - 1) desktopPageIndex++;
  else if (direction < 0 && desktopPageIndex > 0) desktopPageIndex--;
  else {
    const next = currentChapterIndex + direction;
    if (next >= 0 && next < currentBookData.chapters.length) {
      await loadChapter(next);
      if (direction < 0) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        desktopPageIndex = Math.max(0, desktopPageCount - 1);
        updateDesktopPage(false);
      }
    }
    return;
  }
  updateDesktopPage();
}
async function loadChapter(index) {
  currentChapterIndex = index;
  saveCurrentBookProgress();
  readingActive = true;
  ensureReadingTimer();
  selectedParagraph = null;
  selectedText = "";
  selectedLocator = null;
  desktopPageResizeObserver?.disconnect();
  document.querySelectorAll("body > #selectionToolbar").forEach((toolbar) => toolbar.remove());
  viewShell("reader", '<div class="reader-loading">正在载入章节原文…</div>');
  try {
    const response = await fetch(
      "/api/chapter?session_id=" +
        encodeURIComponent(sessionId) +
        "&index=" +
        index,
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "章节读取失败");
    document.getElementById("viewContent").innerHTML =
      '<div class="reader-head"><h2>' +
      escapeHtml(data.title) +
      '</h2><div><button class="chapter-complete" id="chapterComplete">标记本章已读</button> <span class="toc-label">第 ' +
      (data.index + 1) +
      " / " +
      data.total +
      ' 章</span></div></div><div class="reader-format-bar"><label>字体 <select id="readerFont"><option value="serif">宋体阅读</option><option value="yahei">微软雅黑</option><option value="kaiti">楷体</option><option value="heiti">黑体</option></select></label><label>字号 <input id="readerFontSize" type="range" min="14" max="30" step="1"><span class="reader-size-value" id="readerSizeValue">17 px</span></label><label>翻阅方式 <select id="desktopReaderFlow"><option value="scroll">连续滑动</option><option value="page">左右翻页</option></select></label><button class="reader-annotations-button" id="manageAnnotations">批注与高亮</button></div><div class="selection-toolbar" id="selectionToolbar"><button id="copySelection">复制</button><button id="shareSelection">分享书签</button><button id="selectParagraph">段落全选</button><button id="translateSelection">快速翻译</button><button id="aiTranslateSelection">AI 翻译</button><i class="tool-divider"></i><button id="addNote">批注</button><button class="mark-color amber" id="markAmber" title="黄色高亮"></button><button class="mark-color red" id="markRed" title="红色高亮"></button><button class="mark-color blue" id="markBlue" title="蓝色高亮"></button><button class="mark-color green" id="markGreen" title="绿色高亮"></button><button id="aiExplain">AI 解析</button><button id="clearSelection">取消</button></div><div class="reader-body">' +
      data.html +
      '</div><div class="reader-nav"><button id="prevChapter" ' +
      (data.index === 0 ? "disabled" : "") +
      '>← 上一章</button><button id="nextChapter" ' +
      (data.index === data.total - 1 ? "disabled" : "") +
      ">下一章 →</button></div>";
    initReaderTools();
    document.getElementById("chapterComplete").onclick = toggleChapterComplete;
    updateCompleteButton();
    document.getElementById("prevChapter").onclick = () =>
      loadChapter(data.index - 1);
    document.getElementById("nextChapter").onclick = () =>
      loadChapter(data.index + 1);
    setupDesktopReadingFlow(data);
    document
      .querySelectorAll(".chapters button")
      .forEach((x) => x.classList.remove("active"));
    const active = document.querySelector(
      '.chapters button[data-index="' + index + '"]',
    );
    active?.classList.add("active");
    active?.scrollIntoView({ block: "nearest" });
  } catch (error) {
    document.getElementById("viewContent").innerHTML =
      '<div class="reader-loading">' + escapeHtml(error.message) + "</div>";
  }
}
const arrayOf = (value) => (Array.isArray(value) ? value : []);
function chapterChips(chapters) {
  const items = arrayOf(chapters).filter(Boolean);
  return items.length
    ? '<div class="chapter-chips">' +
        items
          .map(
            (chapter) =>
              '<span class="chapter-chip">' + escapeHtml(chapter) + "</span>",
          )
          .join("") +
        "</div>"
    : "";
}
function analysisSection(title, subtitle, content) {
  return content
    ? '<section class="analysis-section"><div class="analysis-section-head"><div><h3>' +
        escapeHtml(title) +
        "</h3>" +
        (subtitle ? "<p>" + escapeHtml(subtitle) + "</p>" : "") +
        "</div></div>" +
        content +
        "</section>"
    : "";
}
function deepAnalysisHtml(a) {
  const executive = a.executive_summary || {},
    guide = a.reading_guide || {},
    domain = a.domain || {};
  let html = '<div class="deep-analysis">';
  if (
    executive.overview ||
    executive.distinctive_value ||
    executive.prerequisites ||
    executive.limitations ||
    domain.best_for
  ) {
    html +=
      '<div class="overview-box">' +
      (executive.overview
        ? '<div class="analysis-card"><b class="overview-label">全书深度概述</b><p>' +
          escapeHtml(executive.overview) +
          "</p></div>"
        : "") +
      (executive.distinctive_value
        ? '<div class="analysis-card"><b class="overview-label">为什么值得读</b><p>' +
          escapeHtml(executive.distinctive_value) +
          "</p></div>"
        : "") +
      (domain.best_for
        ? '<div class="analysis-card"><b class="overview-label">适合谁读</b><p>' +
          escapeHtml(domain.best_for) +
          "</p></div>"
        : "") +
      (executive.prerequisites
        ? '<div class="analysis-card"><b class="overview-label">阅读准备</b><p>' +
          escapeHtml(executive.prerequisites) +
          "</p></div>"
        : "") +
      (executive.limitations
        ? '<div class="analysis-card"><b class="overview-label">边界与局限</b><p>' +
          escapeHtml(executive.limitations) +
          "</p></div>"
        : "") +
      "</div>";
  }
  const concepts = arrayOf(a.core_concepts);
  if (concepts.length)
    html += analysisSection(
      "核心概念词典",
      "先理解这些概念，再进入细节会更轻松。",
      '<div class="analysis-grid">' +
        concepts
          .map(
            (item) =>
              '<div class="analysis-card"><b>' +
              escapeHtml(item.term) +
              "</b><p>" +
              escapeHtml(item.explanation) +
              "</p><p><strong>为什么重要：</strong>" +
              escapeHtml(item.importance) +
              "</p>" +
              chapterChips(item.chapters) +
              "</div>",
          )
          .join("") +
        "</div>",
    );
  const argument = arrayOf(a.argument_map);
  if (argument.length)
    html += analysisSection(
      "作者如何推进论述",
      "从起点、证据到结论，看清全书的思考骨架。",
      '<div class="reading-path">' +
        argument
          .map(
            (item) =>
              '<div class="path-step"><div><b>' +
              escapeHtml(item.stage) +
              "</b><p><strong>主张：</strong>" +
              escapeHtml(item.claim) +
              "</p><p><strong>依据：</strong>" +
              escapeHtml(item.support) +
              "</p><p><strong>承接：</strong>" +
              escapeHtml(item.connection) +
              "</p></div></div>",
          )
          .join("") +
        "</div>",
    );
  const connections = arrayOf(a.chapter_connections);
  if (connections.length)
    html += analysisSection(
      "章节之间的隐藏联系",
      "把分散章节放在同一张关系图中理解。",
      '<div class="analysis-grid">' +
        connections
          .map(
            (item) =>
              '<div class="analysis-card"><b>' +
              escapeHtml(arrayOf(item.chapters).join(" ↔ ")) +
              "</b><p>" +
              escapeHtml(item.connection) +
              "</p><p><strong>阅读提示：</strong>" +
              escapeHtml(item.reading_tip) +
              "</p></div>",
          )
          .join("") +
        "</div>",
    );
  const before = arrayOf(guide.before_reading),
    path = arrayOf(guide.reading_path),
    methods = arrayOf(guide.reading_methods);
  if (before.length || path.length || methods.length) {
    let guideHtml = before.length
      ? '<ul class="analysis-bullets">' +
        before.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") +
        "</ul>"
      : "";
    if (path.length)
      guideHtml +=
        '<div class="reading-path" style="margin-top:12px">' +
        path
          .map(
            (item) =>
              '<div class="path-step"><div><b>' +
              escapeHtml(item.stage) +
              "</b>" +
              chapterChips(item.chapters) +
              "<p><strong>重点：</strong>" +
              escapeHtml(item.focus) +
              "</p><p><strong>带着问题读：</strong>" +
              escapeHtml(item.question) +
              "</p></div></div>",
          )
          .join("") +
        "</div>";
    if (methods.length)
      guideHtml +=
        '<ul class="analysis-bullets" style="margin-top:12px">' +
        methods.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") +
        "</ul>";
    html += analysisSection(
      "建议阅读路线",
      "告诉你先读什么、每一阶段抓什么，以及怎样做笔记。",
      guideHtml,
    );
  }
  const figures = arrayOf(a.key_figures);
  if (figures.length)
    html += analysisSection(
      "关键人物、流派与事件",
      "建立理解本书所需的角色坐标。",
      '<div class="analysis-grid">' +
        figures
          .map(
            (item) =>
              '<div class="analysis-card"><b>' +
              escapeHtml(item.name) +
              "</b><p>" +
              escapeHtml(item.role) +
              "</p><p><strong>重要性：</strong>" +
              escapeHtml(item.importance) +
              "</p>" +
              chapterChips(item.chapters) +
              "</div>",
          )
          .join("") +
        "</div>",
    );
  const misconceptions = arrayOf(a.misconceptions);
  if (misconceptions.length)
    html += analysisSection(
      "容易误解的地方",
      "提前识别过度简化、概念混淆和常见误读。",
      '<div class="analysis-grid">' +
        misconceptions
          .map(
            (item) =>
              '<div class="analysis-card"><b>' +
              escapeHtml(item.misconception) +
              "</b><p><strong>正确理解：</strong>" +
              escapeHtml(item.clarification) +
              "</p><p><strong>误读原因：</strong>" +
              escapeHtml(item.why) +
              "</p></div>",
          )
          .join("") +
        "</div>",
    );
  const questions = arrayOf(a.critical_questions);
  if (questions.length)
    html += analysisSection(
      "批判性阅读问题",
      "不只接受结论，也检验作者的前提、证据与边界。",
      '<div class="analysis-grid">' +
        questions
          .map(
            (item) =>
              '<div class="analysis-card question-card"><b>' +
              escapeHtml(item.question) +
              "</b><p>" +
              escapeHtml(item.why_it_matters) +
              "</p>" +
              chapterChips(item.chapters) +
              "</div>",
          )
          .join("") +
        "</div>",
    );
  const insights = arrayOf(a.practical_insights);
  if (insights.length)
    html += analysisSection(
      "可以带走的启发",
      "把书中的理解迁移到观察、学习与实践。",
      '<div class="analysis-grid">' +
        insights
          .map(
            (item) =>
              '<div class="analysis-card"><b>' +
              escapeHtml(item.insight) +
              "</b><p>" +
              escapeHtml(item.how_to_use) +
              "</p></div>",
          )
          .join("") +
        "</div>",
    );
  const cards = arrayOf(a.memory_cards);
  if (cards.length)
    html += analysisSection(
      "复习卡片",
      "读完后用这些问题快速检查自己是否真正理解。",
      '<div class="memory-grid">' +
        cards
          .map(
            (item) =>
              '<div class="memory-card"><b>' +
              escapeHtml(item.question) +
              "</b><span>" +
              escapeHtml(item.answer) +
              "</span></div>",
          )
          .join("") +
        "</div>",
    );
  const directions = arrayOf(a.further_directions);
  if (directions.length)
    html += analysisSection(
      "延伸探索方向",
      "从本书出发，继续搭建更完整的知识网络。",
      '<div class="analysis-grid">' +
        directions
          .map(
            (item) =>
              '<div class="analysis-card"><b>' +
              escapeHtml(item.direction) +
              "</b><p>" +
              escapeHtml(item.reason) +
              "</p></div>",
          )
          .join("") +
        "</div>",
    );
  return html + "</div>";
}
function render(data) {
  const a = data.analysis || {},
    hasAnalysis = !!data.analysis,
    isDeep =
      Number(a.schema_version) >= 2 || arrayOf(a.core_concepts).length > 0;
  currentBookData = data;
  title.textContent = data.title;
  currentBookKey = data.book_hash || data.title;
  renderDesktopQaTopics();
  const savedProgress = allBookProgress()[currentBookKey];
  currentChapterIndex = Math.max(0, Math.min(data.chapters.length - 1, Number(savedProgress?.chapter) || 0));
  migrateLegacyBookData(data.title, currentBookKey);
  rememberReadingMeta(data);
  document.querySelector(".chapters").innerHTML =
    '<li><button class="active" data-analysis>AI 分析</button></li>' +
    data.chapters
      .map(
        (chapter, i) =>
          '<li><button data-index="' +
          i +
          '">' +
          escapeHtml(chapter) +
          "</button></li>",
      )
      .join("");
  const meta = data.cache_meta,
    revision = meta?.revision_count || 0,
    cacheText = meta
      ? "本地已保存 · " +
        escapeHtml(meta.model || "当前模型") +
        (revision ? " · 已修订 " + revision + " 次" : " · 首次分析")
      : "分析完成后将自动保存到本机",
    buttonText = isDeep ? "二次解析：补充与修订" : "升级为深度分析";
  analysisHtml =
    '<div class="analysis-actions"><span>' +
    cacheText +
    '</span><button id="reanalyzeButton">' +
    buttonText +
    '</button></div><div class="summary-top"><span class="pill">全书概览</span><span class="toc-label">已分析 ' +
    Number(data.analyzed_chars || 0).toLocaleString() +
    " 字</span></div><h2>" +
    escapeHtml(a.one_sentence || data.title) +
    '</h2><p class="lead">' +
    escapeHtml(a.caveat || "以下内容由 AI 基于书籍正文生成。") +
    '</p><div class="goal"><b>作者想回答的问题</b>' +
    escapeHtml(a.book_purpose || "未能提取。") +
    "</div>" +
    (isDeep
      ? deepAnalysisHtml(a)
      : '<div class="legacy-analysis">这份结果来自旧版简要分析。点击“升级为深度分析”，可生成核心概念、论证结构、阅读路线、章节联系、误读提醒、批判性问题和复习卡片。</div>') +
    '<div class="analysis-section"><div class="analysis-section-head"><div><h3>全书结构提纲</h3><p>把各部分放回全书主线中理解。</p></div></div><div class="analysis-grid">' +
    arrayOf(a.outline)
      .map(
        (item) =>
          '<div class="analysis-card"><b>' +
          escapeHtml(item.title) +
          "</b><p>" +
          escapeHtml(item.summary) +
          "</p></div>",
      )
      .join("") +
    '</div></div><div class="analysis-section"><div class="analysis-section-head"><div><h3>值得带走的核心观点</h3><p>适合标记、复述并在读后回看的关键认识。</p></div></div><div class="analysis-grid">' +
    arrayOf(a.key_points)
      .map(
        (item) =>
          '<div class="analysis-card"><b>' +
          escapeHtml(item.title) +
          "</b><p>" +
          escapeHtml(item.detail) +
          "</p>" +
          chapterChips(item.chapters) +
          "</div>",
      )
      .join("") +
    "</div></div>";
  if (!hasAnalysis)
    analysisHtml =
      '<div class="analysis-actions"><span>书籍已导入，AI 尚未启用</span></div><div class="analysis-empty"><span class="pill">按需分析</span><h2>先阅读原文，需要时再生成全书报告</h2><p class="lead">AI 分析不会在导入时自动运行。开始分析后，结果会保存在本机，之后可继续补充与修订。</p><button id="startInitialAnalysis" class="primary">开始 AI 深度分析</button></div>';
  document.querySelector(".chapters button[data-analysis]").onclick =
    showAnalysis;
  document
    .querySelectorAll(".chapters button[data-index]")
    .forEach(
      (btn) => (btn.onclick = () => loadChapter(Number(btn.dataset.index))),
    );
  if (hasAnalysis) showAnalysis();
  else loadChapter(currentChapterIndex);
  workspace.style.display = "grid";
  workspace.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function startInitialAnalysis() {
  if (!currentBookData || !sessionId) return;
  setProgress(22, "准备 AI 分析", "书籍原文已解析完成", "可随时返回原文阅读");
  animateProgress(currentBookData.estimated_seconds || 90);
  try {
    const analyzedResponse = await runAnalysis({ session_id: sessionId }),
      analyzed = await analyzedResponse.json();
    if (!analyzedResponse.ok) throw new Error(analyzed.error || "AI 分析失败");
    clearInterval(progressTimer);
    setProgress(100, "分析完成", "报告已保存到本机", "实际用时 " + analyzed.actual_seconds + " 秒");
    render({ ...currentBookData, analysis: analyzed.analysis, cache_meta: analyzed.cache_meta });
    showNotice("AI 深度报告已生成并保存。");
  } catch (error) {
    clearInterval(progressTimer);
    showNotice(error.message, true);
    setProgress(100, "分析未完成", "原文与阅读记录不受影响", "可稍后重试");
  }
}
async function checkBackend() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    const version = String(data.version || "").match(/^(\d+)\.(\d+)/);
    const compatible = data.service === "yuejian" && version && Number(version[1]) === 1 && Number(version[2]) >= 2;
    if (!response.ok || !compatible)
      throw new Error();
    backendReady = true;
    status.textContent = "本地服务已就绪";
    return true;
  } catch {
    backendReady = false;
    status.textContent = "本地服务需要重启";
    showNotice("当前仍是旧版服务。请完全退出旧版阅见，再打开新版软件。", true);
    return false;
  }
}
checkBackend();
let progressTimer = null;
function setProgress(percent, label, detail, time) {
  document.getElementById("progressCard").classList.add("show");
  document.getElementById("progressFill").style.width = percent + "%";
  document.getElementById("progressLabel").textContent = label;
  document.getElementById("progressDetail").textContent = detail;
  document.getElementById("progressTime").textContent = time;
}
function animateProgress(seconds) {
  clearInterval(progressTimer);
  const started = Date.now();
  progressTimer = setInterval(() => {
    const elapsed = (Date.now() - started) / 1000,
      ratio = Math.min(0.94, elapsed / seconds),
      remaining = Math.max(1, Math.ceil(seconds - elapsed)),
      summarizing = ratio > 0.78;
    setProgress(
      22 + ratio * 70,
      summarizing ? "AI 正在汇总深度报告…" : "AI 正在逐章阅读…",
      summarizing
        ? "整理章节联系、核心概念与阅读路线"
        : "分段生成章节阅读笔记，长书会需要更多时间",
      "预计还需 " + remaining + " 秒",
    );
  }, 700);
}
async function runAnalysis(payload) {
  const progressCard = document.getElementById("progressCard");
  let cancelButton = document.getElementById("cancelAnalysis");
  if (!cancelButton) {
    cancelButton = document.createElement("button");
    cancelButton.id = "cancelAnalysis";
    cancelButton.className = "save analysis-cancel";
    cancelButton.textContent = "取消分析";
    progressCard.appendChild(cancelButton);
  }
  cancelButton.hidden = false;
  cancelButton.disabled = false;
  cancelButton.onclick = async () => {
    cancelButton.disabled = true;
    cancelButton.textContent = "正在取消…";
    try {
      await fetch("/api/analyze/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      setProgress(94, "正在停止分析…", "已完成的分段笔记会保留", "请稍候");
    } catch {
      cancelButton.disabled = false;
      cancelButton.textContent = "重试取消";
    }
  };
  try {
    return await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } finally {
    cancelButton.hidden = true;
    cancelButton.textContent = "取消分析";
  }
}
const analysisConfirmModal = document.getElementById("analysisConfirmModal");
function requestAnalysisConfirmation(upgrading) {
  const chunks = Number(currentBookData?.analysis_chunks || 0),
    target = Number(currentBookData?.chunk_target_chars || 0);
  document.getElementById("analysisConfirmTitle").textContent = upgrading
    ? "升级为分章深度分析？"
    : "补充并修订这份报告？";
  document.getElementById("analysisConfirmMessage").textContent = upgrading
    ? "AI 将逐章阅读并生成笔记，再汇总为结构完整的深度报告。"
    : "AI 将重新逐章阅读，并结合旧报告补充遗漏、纠正含混内容。";
  document.getElementById("analysisConfirmCost").textContent = chunks
    ? "已根据书籍长度、章节复杂度与当前模型，自适应为约 " +
      chunks +
      " 个阅读块（每块最多约 " +
      Math.round(target / 1000) +
      " 千字）"
    : "本次会产生多次 AI 调用，具体次数将根据书籍长度、章节复杂度与当前模型自动决定";
  document.getElementById("acceptAnalysisConfirm").textContent = upgrading
    ? "开始分章分析"
    : "开始补充与修订";
  analysisConfirmModal.classList.add("open");
  return new Promise((resolve) => {
    const finish = (value) => {
      analysisConfirmModal.classList.remove("open");
      document.getElementById("acceptAnalysisConfirm").onclick = null;
      document.getElementById("cancelAnalysisConfirm").onclick = null;
      analysisConfirmModal.onclick = null;
      resolve(value);
    };
    document.getElementById("acceptAnalysisConfirm").onclick = () =>
      finish(true);
    document.getElementById("cancelAnalysisConfirm").onclick = () =>
      finish(false);
    analysisConfirmModal.onclick = (event) => {
      if (event.target === analysisConfirmModal) finish(false);
    };
  });
}
async function reanalyzeBook() {
  if (!currentBookData) return;
  const upgrading =
      Number(currentBookData.analysis?.schema_version) < 2 ||
      !arrayOf(currentBookData.analysis?.core_concepts).length,
    operation = upgrading ? "深度分析升级" : "补充与修订";
  if (!(await requestAnalysisConfirmation(upgrading))) return;
  setProgress(
    22,
    "开始" + operation + "…",
    upgrading
      ? "逐章阅读、生成短笔记并汇总完整报告"
      : "重新逐章阅读，检查旧结果的遗漏与含混",
    "预计约 " + currentBookData.estimated_seconds + " 秒",
  );
  animateProgress(currentBookData.estimated_seconds);
  try {
    const response = await runAnalysis({ session_id: sessionId, revision: true });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || operation + "失败");
    clearInterval(progressTimer);
    setProgress(
      100,
      operation + "完成",
      "已完成 " + (data.chunk_count || 1) + " 个章节分段并汇总",
      "实际用时 " + data.actual_seconds + " 秒",
    );
    render({
      ...currentBookData,
      analysis: data.analysis,
      cache_meta: data.cache_meta,
    });
    showNotice(
      operation +
        "已完成并保存。" +
        (data.format_retry
          ? "汇总结果首次过长，软件已自动压缩修复。"
          : "本次真实耗时已用于优化之后的时间预估。"),
    );
  } catch (error) {
    clearInterval(progressTimer);
    showNotice(error.message, true);
    setProgress(
      100,
      operation + "未完成",
      "原有分析结果保持不变",
      "可以稍后重新尝试",
    );
  }
}
async function continuePrepared(prepared) {
  sessionId = prepared.session_id;
  if (prepared.cached_analysis) {
    setProgress(
      100,
      "已载入本地分析",
      "未调用 AI，直接使用已保存结果",
      "已从本机读取",
    );
    render({
      ...prepared,
      analysis: prepared.cached_analysis,
      cache_meta: prepared.cache_meta,
    });
    showNotice(
      "书籍及其分析结果已从本机载入。如需更新，请点击“二次解析：补充与修订”。",
    );
    return;
  }
  setProgress(100, "书籍导入完成", "已展开原文，未调用 AI", "需要时可点击“AI 分析”");
  render({ ...prepared, analysis: null });
  showNotice("书籍已加入“我的书架”，当前仅打开原文；AI 分析可按需启动。");
}
async function loadBook(file) {
  if (!file) return;
  if (!backendReady && !(await checkBackend())) return;
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["epub", "txt"].includes(ext)) {
    status.textContent = "目前请上传 EPUB 或 TXT 格式的书籍";
    return;
  }
  status.textContent = "正在解析并保存到书架…";
  fileInput.disabled = true;
  setProgress(8, "正在读取电子书…", "识别目录、章节与正文", "计算时间中");
  try {
    const form = new FormData();
    form.append("book", file);
    const preparedResponse = await fetch("/api/prepare", {
      method: "POST",
      body: form,
    });
    const prepared = await preparedResponse.json();
    if (!preparedResponse.ok) throw new Error(prepared.error || "书籍解析失败");
    await continuePrepared(prepared);
  } catch (error) {
    clearInterval(progressTimer);
    showNotice(error.message, true);
    status.textContent = "未能完成分析";
    setProgress(100, "分析未完成", "请检查 AI 设置或书籍格式", "需要处理");
  } finally {
    fileInput.disabled = false;
  }
}
fileInput.addEventListener("change", (e) => loadBook(e.target.files[0]));
["dragenter", "dragover"].forEach((e) =>
  drop.addEventListener(e, (x) => {
    x.preventDefault();
    drop.style.background = "rgba(217,234,154,.12)";
  }),
);
["dragleave", "drop"].forEach((e) =>
  drop.addEventListener(e, (x) => {
    x.preventDefault();
    drop.style.background = "";
  }),
);
drop.addEventListener("drop", (e) => loadBook(e.dataTransfer.files[0]));
const QA_TOPIC_PREFIX = "yuejian-qa-topic-";
function desktopQaTopics() {
  const topics = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(QA_TOPIC_PREFIX)) continue;
    try { const topic = JSON.parse(localStorage.getItem(key)); if (topic && typeof topic === "object") topics.push(topic); } catch {}
  }
  return topics.filter((topic) => topic.bookId === currentBookKey).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
function saveDesktopQaTopic(topic) {
  topic.updatedAt = Number(topic.updatedAt) || Date.now();
  topic.messages = Array.isArray(topic.messages) ? topic.messages.slice(-80).map(message => ({ ...message, content: String(message.content || "").slice(0, 5000) })) : [];
  localStorage.setItem(QA_TOPIC_PREFIX + topic.id, JSON.stringify(topic));
}
function ensureDesktopQaUi() {
  if (document.getElementById("qaTopicBar")) return;
  answer.insertAdjacentHTML("beforebegin", '<section id="qaTopicBar" class="qa-topic-bar"><header><div><small>随书资料</small><strong>问答议题</strong></div><button id="qaNewTopic">＋ 新议题</button></header><div id="qaTopicList" class="qa-topic-list"></div></section>');
  document.getElementById("qaNewTopic").onclick = () => { activeQaTopicId = ""; renderDesktopQaTopics(); document.getElementById("question").focus(); };
  document.body.insertAdjacentHTML("beforeend", '<div id="qaEditorModal" class="qa-editor-modal"><section class="qa-editor-card"><header><div><small>资料议题</small><h2>编辑问答内容</h2></div><button id="qaEditorClose" aria-label="关闭">×</button></header><label>议题名称<input id="qaEditorTitle" maxlength="80"></label><div id="qaEditorMessages"></div><footer><button id="qaEditorDelete" class="danger">删除议题</button><span></span><button id="qaEditorCancel">取消</button><button id="qaEditorSave" class="primary">保存修改</button></footer></section></div>');
  const close = () => { document.getElementById("qaEditorModal").classList.remove("open"); document.getElementById("qaEditorDelete").dataset.confirm = ""; document.getElementById("qaEditorDelete").textContent = "删除议题"; };
  document.getElementById("qaEditorClose").onclick = close; document.getElementById("qaEditorCancel").onclick = close;
  document.getElementById("qaEditorModal").onclick = event => { if (event.target.id === "qaEditorModal") close(); };
}
function renderDesktopQaTopics() {
  ensureDesktopQaUi();
  const topics = desktopQaTopics().filter((topic) => !topic.deleted);
  if (activeQaTopicId && !topics.some((topic) => topic.id === activeQaTopicId)) activeQaTopicId = "";
  if (!activeQaTopicId && topics.length) activeQaTopicId = topics[0].id;
  const list = document.getElementById("qaTopicList");
  list.innerHTML = topics.length ? topics.map((topic) => `<article class="qa-topic-chip ${topic.id === activeQaTopicId ? "active" : ""}" data-topic-id="${escapeHtml(topic.id)}"><button class="qa-topic-open"><b>${escapeHtml(topic.title || "未命名议题")}</b><span>${topic.messages?.length || 0} 条记录</span></button><button class="qa-topic-edit" aria-label="编辑议题">•••</button></article>`).join("") : '<div class="qa-topic-empty">提出问题后会自动保存为可继续整理的资料议题。</div>';
  list.querySelectorAll(".qa-topic-open").forEach(button => button.onclick = () => { activeQaTopicId = button.parentElement.dataset.topicId; renderDesktopQaTopics(); });
  list.querySelectorAll(".qa-topic-edit").forEach(button => button.onclick = () => openDesktopQaEditor(button.parentElement.dataset.topicId));
  const topic = topics.find((item) => item.id === activeQaTopicId);
  answer.innerHTML = topic ? topic.messages.map(message => `<div class="qa-message ${message.role}"><b>${message.role === "user" ? "我的问题" : "阅见回答"}</b><p>${escapeHtml(message.content).replace(/\n/g, "<br>")}</p></div>`).join("") : '<div class="qa-welcome"><b>新建议题</b><p>输入一个关于本书的问题。回答会永久保存在本书资料中，并可继续追问。</p></div>';
  document.getElementById("question").placeholder = topic ? "继续追问这个议题…" : "输入新议题的问题…";
  answer.scrollTop = answer.scrollHeight;
}
function openDesktopQaEditor(id) {
  ensureDesktopQaUi(); const topic = desktopQaTopics().find((item) => item.id === id && !item.deleted); if (!topic) return;
  const modal = document.getElementById("qaEditorModal"), titleInput = document.getElementById("qaEditorTitle"), messages = document.getElementById("qaEditorMessages"), deleteButton = document.getElementById("qaEditorDelete");
  modal.dataset.topicId = id; titleInput.value = topic.title || "";
  messages.innerHTML = (topic.messages || []).map((message, index) => `<label>${message.role === "user" ? "问题" : "回答"}<textarea data-message-index="${index}" rows="${message.role === "user" ? 3 : 6}">${escapeHtml(message.content)}</textarea></label>`).join("");
  deleteButton.dataset.confirm = ""; deleteButton.textContent = "删除议题";
  deleteButton.onclick = () => { if (!deleteButton.dataset.confirm) { deleteButton.dataset.confirm = "yes"; deleteButton.textContent = "再次点击确认删除"; return; } topic.deleted = true; topic.updatedAt = Date.now(); saveDesktopQaTopic(topic); if (activeQaTopicId === id) activeQaTopicId = ""; modal.classList.remove("open"); renderDesktopQaTopics(); };
  document.getElementById("qaEditorSave").onclick = () => { topic.title = titleInput.value.trim().slice(0, 80) || "未命名议题"; messages.querySelectorAll("textarea").forEach(field => { const message = topic.messages[Number(field.dataset.messageIndex)]; if (message) { message.content = field.value.trim().slice(0, 20000); message.updatedAt = Date.now(); } }); topic.updatedAt = Date.now(); saveDesktopQaTopic(topic); modal.classList.remove("open"); renderDesktopQaTopics(); showNotice("问答议题已更新。"); };
  modal.classList.add("open");
}
async function ask() {
  const question = document.getElementById("question"),
    button = document.getElementById("askButton");
  const rawQuestion = question.value.trim();
  if (!rawQuestion) return;
  if (!sessionId) {
    answer.innerHTML =
      "<b>请先分析一本书</b>上传书籍后，我才能根据其内容回答。";
    return;
  }
  let topic = desktopQaTopics().find((item) => item.id === activeQaTopicId && !item.deleted);
  if (!topic) {
    const now = Date.now();
    topic = { id: "qa-" + now.toString(36) + Math.random().toString(36).slice(2, 8), bookId: currentBookKey, bookTitle: currentBookData?.title || "未命名书籍", title: rawQuestion.slice(0, 36), createdAt: now, updatedAt: now, messages: [] };
    activeQaTopicId = topic.id;
  }
  const context = topic.messages.slice(-10).map((message) => `${message.role === "user" ? "读者" : "阅见"}：${message.content}`).join("\n\n"), now = Date.now();
  topic.messages.push({ id: "msg-" + now.toString(36), role: "user", content: rawQuestion, createdAt: now, updatedAt: now });
  topic.updatedAt = now; saveDesktopQaTopic(topic); question.value = ""; renderDesktopQaTopics();
  button.disabled = true;
  answer.insertAdjacentHTML("beforeend", '<div class="qa-message assistant pending"><b>阅见</b><p>正在查找书中的答案…</p></div>');
  try {
    const prompt = context ? `这是同一资料议题中的继续追问。请结合此前讨论与书中内容回答最新问题。\n\n此前讨论：\n${context.slice(-8000)}\n\n最新问题：${rawQuestion}` : rawQuestion;
    const response = await fetch("/api/question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, question: prompt }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "回答失败");
    const finished = Date.now(); topic.messages.push({ id: "msg-" + finished.toString(36), role: "assistant", content: data.answer, createdAt: finished, updatedAt: finished }); topic.updatedAt = finished; saveDesktopQaTopic(topic); renderDesktopQaTopics();
  } catch (error) {
    renderDesktopQaTopics(); showNotice(error.message || "暂时无法回答", true);
  } finally {
    button.disabled = false;
  }
}
const settingsModal = document.getElementById("settingsModal"),
  provider = document.getElementById("provider"),
  modelPreset = document.getElementById("modelPreset"),
  model = document.getElementById("model");
const MODEL_PRESETS = {
  deepseek: [
    ["DeepSeek Flash（速度优先）", "deepseek-v4-flash"],
    ["DeepSeek Pro（质量优先）", "deepseek-v4-pro"],
  ],
  openai: [
    ["GPT-5.6 Luna（经济快速）", "gpt-5.6-luna"],
    ["GPT-5.6 Terra（均衡推荐）", "gpt-5.6-terra"],
    ["GPT-5.6 Sol（高质量）", "gpt-5.6-sol"],
    ["GPT-5.5（复杂任务）", "gpt-5.5"],
    ["GPT-5.4 mini（快速）", "gpt-5.4-mini"],
    ["GPT-5.4 nano（最低成本）", "gpt-5.4-nano"],
    ["GPT-5 mini（兼容旧版）", "gpt-5-mini"],
    ["GPT-5（兼容旧版）", "gpt-5"],
  ],
};
function selectModel(value) {
  const presets = MODEL_PRESETS[provider.value] || [];
  const known = presets.some((entry) => entry[1] === value);
  modelPreset.value = known ? value : "__custom__";
  model.hidden = known;
  model.value = known ? "" : value || "";
}
function selectedModel() {
  return modelPreset.value === "__custom__" ? model.value.trim() : modelPreset.value;
}
function updateProvider(selected = "") {
  const deepseek = provider.value === "deepseek";
  document.getElementById("keyLabel").textContent = deepseek
    ? "DeepSeek"
    : "OpenAI";
  const presets = MODEL_PRESETS[provider.value] || [];
  modelPreset.innerHTML = presets
    .map(([label, value]) => '<option value="' + value + '">' + label + "</option>")
    .concat('<option value="__custom__">自定义模型…</option>')
    .join("");
  selectModel(selected || presets[0][1]);
}
async function loadConfigStatus() {
  try {
    const response = await fetch("/api/config-status", { cache: "no-store" }),
      data = await response.json();
    if (!response.ok) return;
    if (data.configured) {
      provider.value = data.provider;
      updateProvider(data.model);
      document.getElementById("settingsButton").textContent = "AI 已设置";
      document.getElementById("apiKey").placeholder =
        "已安全保存，留空可继续使用";
    } else document.getElementById("settingsButton").textContent = "AI 设置";
  } catch {}
}
provider.addEventListener("change", () => updateProvider());
modelPreset.addEventListener("change", () => {
  const custom = modelPreset.value === "__custom__";
  model.hidden = !custom;
  if (custom) model.focus();
});
updateProvider();
loadConfigStatus();
document.getElementById("settingsButton").addEventListener("click", () => {
  openExclusiveModal(settingsModal);
  document.getElementById("apiKey").focus();
});
document
  .getElementById("cancelSettings")
  .addEventListener("click", () => settingsModal.classList.remove("open"));
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.remove("open");
});
document.getElementById("saveSettings").addEventListener("click", async () => {
  const button = document.getElementById("saveSettings");
  button.disabled = true;
  button.textContent = "正在验证…";
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: provider.value,
        api_key: document.getElementById("apiKey").value,
        model: selectedModel(),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存失败");
    document.getElementById("apiKey").value = "";
    document.getElementById("apiKey").placeholder =
      "已安全保存，留空可继续使用";
    document.getElementById("settingsButton").textContent = "AI 已设置";
    settingsModal.classList.remove("open");
    showNotice(
      "连接成功，" + data.model + " 的 API 设置已由 Windows 加密保存。",
    );
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "验证并保存";
  }
});
const themeModal = document.getElementById("themeModal"),
  themeSelect = document.getElementById("themeSelect"),
  backgroundInput = document.getElementById("backgroundInput");
function applyTheme() {
  const saved = localStorage.getItem("yuejian-theme") || "starry",
    bg = localStorage.getItem("yuejian-custom-bg");
  themeSelect.value = saved;
  document.body.dataset.theme = saved;
  if (bg) {
    document.body.style.setProperty("--custom-bg", 'url("' + bg + '")');
    document.body.classList.add("has-custom-bg");
  } else document.body.classList.remove("has-custom-bg");
}
applyTheme();
themeSelect.addEventListener("change", () => {
  localStorage.setItem("yuejian-theme", themeSelect.value);
  applyTheme();
});
document.getElementById("themeButton").onclick = () =>
  openExclusiveModal(themeModal);
document.getElementById("closeTheme").onclick = () =>
  themeModal.classList.remove("open");
themeModal.addEventListener("click", (e) => {
  if (e.target === themeModal) themeModal.classList.remove("open");
});
document.getElementById("clearBackground").onclick = () => {
  localStorage.removeItem("yuejian-custom-bg");
  backgroundInput.value = "";
  applyTheme();
};
backgroundInput.addEventListener("change", () => {
  const file = backgroundInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1920 / image.width, 1200 / image.height),
        canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas
        .getContext("2d")
        .drawImage(image, 0, 0, canvas.width, canvas.height);
      try {
        localStorage.setItem(
          "yuejian-custom-bg",
          canvas.toDataURL("image/jpeg", 0.78),
        );
        applyTheme();
        showNotice("自定义背景已保存到本机。");
      } catch {
        showNotice("图片仍然过大，请换一张尺寸较小的图片。", true);
      }
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});
const bookshelfModal = document.getElementById("bookshelfModal"),
  libraryGrid = document.getElementById("libraryGrid");
function formatFileSize(bytes) {
  return bytes > 1048576
    ? (bytes / 1048576).toFixed(1) + " MB"
    : Math.max(1, Math.round(bytes / 1024)) + " KB";
}
function formatLibraryDate(value) {
  if (!value) return "刚刚加入";
  const date = new Date(value);
  return (
    "最近阅读 " +
    date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
  );
}
async function refreshLibrary() {
  libraryGrid.innerHTML = '<div class="library-empty">正在整理书架…</div>';
  try {
    const response = await fetch("/api/library", { cache: "no-store" }),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || "书架读取失败");
    libraryGrid.innerHTML = data.books.length
      ? data.books
          .map((book) => {
            const cover = book.has_cover
              ? '<img class="library-cover" src="' +
                book.cover_url +
                '" alt="' +
                escapeHtml(book.title) +
                '封面">'
              : '<div class="library-cover generated-cover"><small>阅见书架</small><strong>' +
                escapeHtml(book.title) +
                "</strong><span>YUEJIAN</span></div>";
            return (
              '<div class="library-book">' +
              cover +
              '<div class="library-info"><b title="' +
              escapeHtml(book.title) +
              '">' +
              escapeHtml(book.title) +
              "</b><span>" +
              escapeHtml(book.original_name.split(".").pop().toUpperCase()) +
              " · " +
              formatFileSize(book.file_size) +
              " · " +
              (book.analyzed ? "已有 AI 分析" : "等待分析") +
              "</span><span>" +
              formatLibraryDate(book.last_opened) +
              '</span></div><div class="library-actions"><button class="library-open" data-book-hash="' +
              book.book_hash +
              '">继续阅读</button><button class="library-delete" data-book-hash="' +
              book.book_hash +
              '" data-book-title="' +
              escapeHtml(book.title) +
              '">删除</button></div></div>'
            );
          })
          .join("")
      : '<div class="library-empty">书架还是空的。上传第一本 EPUB 或 TXT 后，它会自动出现在这里。</div>';
    document
      .querySelectorAll(".library-open")
      .forEach(
        (button) =>
          (button.onclick = () => openLibraryBook(button.dataset.bookHash)),
      );
    document.querySelectorAll(".library-delete").forEach((button) => {
      button.onclick = () =>
        deleteLibraryBook(button.dataset.bookHash, button.dataset.bookTitle);
    });
    await refreshStorageStatus();
  } catch (error) {
    libraryGrid.innerHTML =
      '<div class="library-empty">' + escapeHtml(error.message) + "</div>";
  }
}
async function refreshStorageStatus() {
  try {
    const response = await fetch("/api/storage/status", { cache: "no-store" });
    const data = await response.json();
    if (response.ok)
      document.getElementById("storageSummary").textContent =
        "本地数据 " + formatFileSize(data.total) + " · 当前会话 " + data.sessions;
  } catch {
    document.getElementById("storageSummary").textContent = "暂时无法统计存储";
  }
}
async function deleteLibraryBook(bookHash, bookTitle) {
  if (!window.confirm("确定删除《" + bookTitle + "》及其分析缓存吗？")) return;
  try {
    const response = await fetch("/api/library/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book_hash: bookHash }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "删除失败");
    showNotice("《" + data.title + "》已从本机删除。");
    await refreshLibrary();
  } catch (error) {
    showNotice(error.message, true);
  }
}
async function openLibraryBook(bookHash) {
  bookshelfModal.classList.remove("open");
  status.textContent = "正在从书架打开…";
  setProgress(8, "正在打开本地书籍…", "恢复章节、分析结果与阅读记录", "请稍候");
  try {
    const response = await fetch("/api/library/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book_hash: bookHash }),
      }),
      prepared = await response.json();
    if (!response.ok) throw new Error(prepared.error || "书籍打开失败");
    await continuePrepared(prepared);
  } catch (error) {
    clearInterval(progressTimer);
    showNotice(error.message, true);
    setProgress(100, "未能打开书籍", "原文件可能已被移除", "需要处理");
  }
}
document.getElementById("bookshelfButton").onclick = () => {
  openExclusiveModal(bookshelfModal);
  refreshLibrary();
};
document.getElementById("closeBookshelf").onclick = () =>
  bookshelfModal.classList.remove("open");
bookshelfModal.addEventListener("click", (e) => {
  if (e.target === bookshelfModal) bookshelfModal.classList.remove("open");
});
document.getElementById("clearAnalysisCache").onclick = async () => {
  if (!window.confirm("确定清理全部 AI 报告和分段缓存吗？书籍与阅读记录会保留。")) return;
  const response = await fetch("/api/cache/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await response.json();
  showNotice(response.ok ? "分析缓存已清理。" : data.error || "清理失败", !response.ok);
  await refreshLibrary();
};
document.getElementById("restoreData").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!window.confirm("恢复备份会合并并覆盖同名的本地数据，是否继续？")) {
    event.target.value = "";
    return;
  }
  const form = new FormData();
  form.append("backup", file);
  try {
    const response = await fetch("/api/data/restore", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "恢复失败");
    showNotice("备份恢复完成，共识别 " + data.books + " 本书；页面即将刷新。");
    setTimeout(() => location.reload(), 900);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    event.target.value = "";
  }
});
const catalogModal = document.getElementById("catalogModal"),
  catalogGrid = document.getElementById("catalogGrid"),
  catalogQuery = document.getElementById("catalogQuery");
async function searchCatalog() {
  const query = catalogQuery.value.trim(),
    button = document.getElementById("catalogSearchButton");
  if (!query) {
    catalogQuery.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "正在搜索…";
  catalogGrid.innerHTML =
    '<div class="catalog-empty">正在连接公益书库并整理结果…</div>';
  try {
    const response = await fetch(
        "/api/catalog/search?q=" + encodeURIComponent(query) + "&source=all",
        { cache: "no-store" },
      ),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || "搜索失败");
    document.getElementById("catalogNotice").textContent = data.rights_notice;
    catalogGrid.innerHTML = data.books.length
      ? data.books
          .map(
            (book) =>
              '<article class="catalog-book"><img class="catalog-cover" src="' +
              escapeHtml(book.cover) +
              '" alt="' +
              escapeHtml(book.title) +
              '封面"><div class="catalog-cover-fallback">' +
              escapeHtml(book.title) +
              '</div><div class="catalog-info"><b>' +
              escapeHtml(book.title) +
              "</b><span>" +
              escapeHtml(book.source) +
              " · " +
              escapeHtml(book.author) +
              "</span><span>" +
              escapeHtml(book.rights_note) +
              '</span></div><div class="catalog-links"><a class="catalog-source" href="' +
              escapeHtml(book.catalog_url) +
              '" target="_blank" rel="noopener">查看来源 ↗</a><button class="catalog-download" data-catalog-id="' +
              escapeHtml(book.id) +
              '">保存到书架</button></div></article>',
          )
          .join("")
      : '<div class="catalog-empty">没有找到匹配的自由电子书。可尝试中文书名、作者名或更短关键词。</div>';
    document
      .querySelectorAll(".catalog-download")
      .forEach(
        (downloadButton) =>
          (downloadButton.onclick = () => downloadCatalogBook(downloadButton)),
      );
    document.querySelectorAll(".catalog-cover").forEach((image) => {
      image.onerror = () => {
        image.style.display = "none";
        image.nextElementSibling.style.display = "grid";
      };
    });
  } catch (error) {
    catalogGrid.innerHTML =
      '<div class="catalog-empty">' + escapeHtml(error.message) + "</div>";
  } finally {
    button.disabled = false;
    button.textContent = "搜索免费书籍";
  }
}
async function downloadCatalogBook(button) {
  button.disabled = true;
  button.textContent = "下载并保存…";
  try {
    const response = await fetch("/api/catalog/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book_id: button.dataset.catalogId }),
      }),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || "下载失败");
    button.textContent = "已保存到书架";
    showNotice(
      "《" + data.title + "》已从" + data.source + "保存到“我的书架”。",
    );
    status.textContent = "在线书籍已保存到本机书架";
  } catch (error) {
    button.disabled = false;
    button.textContent = "重新下载";
    showNotice(error.message, true);
  }
}
document.getElementById("onlineLibraryButton").onclick = () => {
  openExclusiveModal(catalogModal);
  setTimeout(() => catalogQuery.focus(), 50);
};
document.getElementById("closeCatalog").onclick = () =>
  catalogModal.classList.remove("open");
catalogModal.addEventListener("click", (e) => {
  if (e.target === catalogModal) catalogModal.classList.remove("open");
});
document.getElementById("catalogSearchButton").onclick = searchCatalog;
catalogQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchCatalog();
});
function normalizeImportedQuote(item) {
  if (!item || typeof item !== "object") return null;
  const original = String(
      item.original || item.quote || item.text || "",
    ).trim(),
    translation = String(
      item.translation || item.chinese || item.译文 || "",
    ).trim(),
    author = String(item.author || item.source || item.作者 || "").trim();
  return original && author
    ? {
        original: original.slice(0, 2000),
        translation: translation.slice(0, 2000),
        author: author.slice(0, 300),
      }
    : null;
}
function parseQuoteBlock(block) {
  const cleaned = block.trim().replace(/^\s*(?:\d+[.)、]|[•●])\s*/, "");
  if (!cleaned) return null;
  const pipe = cleaned
    .split(/\s*[|｜]\s*/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (pipe.length >= 3)
    return normalizeImportedQuote({
      original: pipe[0],
      translation: pipe.slice(1, -1).join(" "),
      author: pipe[pipe.length - 1],
    });
  if (pipe.length === 2)
    return normalizeImportedQuote({ original: pipe[0], author: pipe[1] });
  const inline = cleaned.match(/^([\s\S]+?)\s*[—–]{2}\s*([^\n]+)$/);
  if (inline)
    return normalizeImportedQuote({ original: inline[1], author: inline[2] });
  const lines = cleaned
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  let author = "",
    body = lines.slice(),
    authorMatch = body[body.length - 1].match(
      /^(?:作者\s*[:：]\s*|[—–-]{1,2}\s*)(.+)$/,
    );
  if (authorMatch) {
    author = authorMatch[1].trim();
    body.pop();
  } else {
    const lastInline = body[body.length - 1].match(/^(.+?)\s*[—–]{2}\s*(.+)$/);
    if (lastInline) {
      body[body.length - 1] = lastInline[1].trim();
      author = lastInline[2].trim();
    }
  }
  if (!author || !body.length) return null;
  let translation = "",
    original = "";
  const translated = body.findIndex((line) =>
    /^(?:翻译|译文|中文)\s*[:：]/.test(line),
  );
  if (translated >= 0) {
    original = body.slice(0, translated).join("\n");
    translation = body
      .slice(translated)
      .join("\n")
      .replace(/^(?:翻译|译文|中文)\s*[:：]\s*/, "");
  } else if (
    body.length === 2 &&
    /[A-Za-zÀ-ž]/.test(body[0]) &&
    /[\u3400-\u9fff]/.test(body[1])
  ) {
    original = body[0];
    translation = body[1];
  } else original = body.join("\n");
  return normalizeImportedQuote({ original, translation, author });
}
function parseQuotesLocally(text) {
  const cleaned = text.trim();
  if (!cleaned) return [];
  try {
    const parsed = JSON.parse(cleaned),
      items = Array.isArray(parsed) ? parsed : parsed.quotes;
    if (Array.isArray(items))
      return items.map(normalizeImportedQuote).filter(Boolean);
  } catch {}
  const lines = cleaned
      .split(/\n+/)
      .map((value) => value.trim())
      .filter(Boolean),
    lineQuotes = lines.map(parseQuoteBlock).filter(Boolean);
  if (lineQuotes.length > 1 && lineQuotes.length === lines.length)
    return lineQuotes;
  return cleaned
    .split(/\n\s*\n+|(?=^\s*(?:\d+[.)、]|[•●])\s*)/m)
    .map(parseQuoteBlock)
    .filter(Boolean);
}
function saveImportedQuotes(quotes) {
  const custom = storedJson("yuejian-quote-custom", []),
    known = new Set(
      activeQuotes().map((item) =>
        (item.original + "\n" + item.author).toLowerCase(),
      ),
    ),
    stamp = Date.now();
  let added = 0;
  quotes.slice(0, 200).forEach((item, index) => {
    const quote = normalizeImportedQuote(item),
      key = quote ? (quote.original + "\n" + quote.author).toLowerCase() : "";
    if (quote && !known.has(key)) {
      known.add(key);
      custom.push({ id: "custom-" + stamp + "-" + index, ...quote });
      added++;
    }
  });
  localStorage.setItem(
    "yuejian-quote-custom",
    JSON.stringify(custom.slice(-1000)),
  );
  renderQuoteLibrary();
  showRandomQuote();
  return added;
}
async function importQuotesInBulk() {
  const input = document.getElementById("bulkQuoteText"),
    button = document.getElementById("importQuotes"),
    text = input.value.trim();
  if (!text) {
    showNotice("请先粘贴需要导入的名言。", true);
    input.focus();
    return;
  }
  if (text.length > 50000) {
    showNotice("单次批量内容不能超过 5 万字。", true);
    return;
  }
  button.disabled = true;
  button.textContent = "正在识别与拆分…";
  let quotes = parseQuotesLocally(text),
    usedAI = false;
  const authorSignals = (
    text.match(/[—–]{2}\s*[^\n]+|(?:^|\n)\s*(?:作者\s*[:：]|[—–-]\s+)\S+/gm) ||
    []
  ).length;
  try {
    if (
      !quotes.length ||
      (authorSignals > 1 && quotes.length < authorSignals)
    ) {
      usedAI = true;
      button.textContent = "格式较复杂，正在请 AI 拆分…";
      const response = await fetch("/api/quotes/parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        }),
        data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI 未能拆分名言");
      quotes = Array.isArray(data.quotes) ? data.quotes : [];
    }
    const added = saveImportedQuotes(quotes);
    if (!added) throw new Error("没有发现可导入的新名言，内容可能已存在。");
    input.value = "";
    showNotice(
      "已" + (usedAI ? "通过 AI " : "") + "识别并导入 " + added + " 句名言。",
    );
  } catch (error) {
    if (quotes.length) {
      const added = saveImportedQuotes(quotes);
      if (added) {
        input.value = "";
        showNotice(
          "AI 辅助不可用，已用本地规则导入 " + added + " 句；请检查其余格式。",
          true,
        );
        return;
      }
    }
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "自动拆分并导入";
  }
}
const quoteModal = document.getElementById("quoteModal");
document.getElementById("quoteLibraryButton").onclick = () => {
  openExclusiveModal(quoteModal);
  renderQuoteLibrary();
};
document.getElementById("closeQuotes").onclick = () =>
  quoteModal.classList.remove("open");
quoteModal.addEventListener("click", (e) => {
  if (e.target === quoteModal) quoteModal.classList.remove("open");
});
document.getElementById("resumeRandomQuote").onclick = () => {
  localStorage.removeItem("yuejian-quote-pinned");
  showRandomQuote(true);
  renderQuoteLibrary();
  showNotice("已恢复为每次启动随机展示名言。");
};
document.getElementById("addQuote").onclick = () => {
  const original = document.getElementById("newQuoteOriginal").value.trim(),
    translation = document.getElementById("newQuoteTranslation").value.trim(),
    author = document.getElementById("newQuoteAuthor").value.trim();
  if (!original || !author) {
    showNotice("请填写名言原文和作者。", true);
    return;
  }
  const custom = storedJson("yuejian-quote-custom", []);
  custom.push({ id: "custom-" + Date.now(), original, translation, author });
  localStorage.setItem("yuejian-quote-custom", JSON.stringify(custom));
  ["newQuoteOriginal", "newQuoteTranslation", "newQuoteAuthor"].forEach(
    (id) => (document.getElementById(id).value = ""),
  );
  renderQuoteLibrary();
  showRandomQuote();
  showNotice("名言已保存到本机名言库。");
};
document.getElementById("importQuotes").onclick = importQuotesInBulk;
function reportDateKey(date = new Date()) {
  const year = date.getFullYear(),
    month = String(date.getMonth() + 1).padStart(2, "0"),
    day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}
function migrateLegacyBookData(title, bookKey) {
  if (!title || !bookKey || title === bookKey) return;
  const stats = allReadingStats();
  if (stats[title] && !stats[bookKey]) {
    stats[bookKey] = stats[title];
    delete stats[title];
    localStorage.setItem("yuejian-reading-stats", JSON.stringify(stats));
  }
  const savedAnnotations = annotations();
  let annotationsChanged = false;
  Object.keys(savedAnnotations).forEach((key) => {
    if (key.startsWith(title + "::")) {
      const migrated = bookKey + key.slice(title.length);
      if (!savedAnnotations[migrated]) savedAnnotations[migrated] = savedAnnotations[key];
      delete savedAnnotations[key];
      annotationsChanged = true;
    }
  });
  if (annotationsChanged)
    localStorage.setItem(
      "yuejian-annotations",
      JSON.stringify(savedAnnotations),
    );
  const metadata = readingMetaStore();
  if (metadata[title] && !metadata[bookKey]) {
    metadata[bookKey] = metadata[title];
    delete metadata[title];
    localStorage.setItem("yuejian-reading-meta", JSON.stringify(metadata));
  }
}

function readingMetaStore() {
  try {
    return JSON.parse(localStorage.getItem("yuejian-reading-meta") || "{}");
  } catch {
    return {};
  }
}
function rememberReadingMeta(data = currentBookData) {
  if (!data?.title) return;
  const all = readingMetaStore(),
    domain = data.analysis?.domain || {};
  all[data.book_hash || data.title] = {
    title: data.title,
    totalChars: Number(data.total_chars || data.analyzed_chars || 0),
    chapters: Array.isArray(data.chapters) ? data.chapters.length : 0,
    category: domain.primary || guessDomain(data.title),
    secondary: Array.isArray(domain.secondary) ? domain.secondary : [],
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem("yuejian-reading-meta", JSON.stringify(all));
}
function reportPeriod(scale) {
  const now = new Date(),
    start = new Date(now),
    end = new Date(now);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  if (scale === "week") {
    const offset = (now.getDay() + 6) % 7;
    start.setDate(now.getDate() - offset);
    end.setDate(start.getDate() + 6);
  } else if (scale === "month") {
    start.setDate(1);
    end.setMonth(now.getMonth() + 1, 0);
  } else if (scale === "year") {
    start.setMonth(0, 1);
    end.setMonth(11, 31);
  }
  return { start, end };
}
function reportEntries(scale) {
  const stats = allReadingStats(),
    meta = readingMetaStore(),
    period = reportPeriod(scale),
    start = reportDateKey(period.start),
    end = reportDateKey(period.end);
  return Object.entries(stats)
    .map(([book, value]) => {
      const daily = value.daily || {},
        dailyChars = value.dailyChars || {};
      let seconds = 0,
        chars = 0;
      Object.entries(daily).forEach(([key, time]) => {
        if (key >= start && key <= end) {
          const amount = Number(time) || 0;
          seconds += amount;
          chars += Number(dailyChars[key] || (amount * 500) / 60);
        }
      });
      const info = meta[book] || {};
      return {
        book: info.title || book,
        seconds,
        chars,
        category: info.category || guessDomain(info.title || book),
        completed: Array.isArray(value.completed) ? value.completed.length : 0,
        totalChapters: Number(info.chapters || 0),
      };
    })
    .filter((item) => item.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
}
function reportChars(chars) {
  return chars >= 10000
    ? (chars / 10000).toFixed(chars >= 100000 ? 0 : 1) + "万字"
    : Math.round(chars).toLocaleString() + "字";
}
function reportMetric(label, value) {
  return (
    '<div class="report-metric"><span>' +
    escapeHtml(label) +
    "</span><b>" +
    escapeHtml(String(value)) +
    "</b></div>"
  );
}
function reportBookRows(entries, limit = 8) {
  return (
    '<div class="report-book-list">' +
    entries
      .slice(0, limit)
      .map(
        (item) =>
          '<div class="report-book-row"><div><strong title="' +
          escapeHtml(item.book) +
          '">' +
          escapeHtml(item.book) +
          "</strong><small>" +
          escapeHtml(item.category) +
          (item.totalChapters
            ? " · 已标记 " + item.completed + "/" + item.totalChapters + " 章"
            : "") +
          "</small></div><b>" +
          formatReadingTime(item.seconds) +
          "<br><small>" +
          reportChars(item.chars) +
          "</small></b></div>",
      )
      .join("") +
    "</div>"
  );
}
function reportCategories(entries) {
  const map = new Map();
  entries.forEach((item) => {
    const row = map.get(item.category) || {
      category: item.category,
      books: new Set(),
      seconds: 0,
      chars: 0,
    };
    row.books.add(item.book);
    row.seconds += item.seconds;
    row.chars += item.chars;
    map.set(item.category, row);
  });
  return [...map.values()].sort((a, b) => b.seconds - a.seconds);
}
function reportDistribution(rows, valueKey = "seconds") {
  const max = Math.max(1, ...rows.map((row) => row[valueKey]));
  return (
    '<div class="report-distribution">' +
    rows
      .map(
        (row) =>
          '<div class="report-distribution-row"><span title="' +
          escapeHtml(row.category || row.book) +
          '">' +
          escapeHtml(row.category || row.book) +
          '</span><i style="width:' +
          Math.max(5, Math.round((row[valueKey] / max) * 100)) +
          '%"></i><b>' +
          (valueKey === "seconds"
            ? formatReadingTime(row.seconds)
            : reportChars(row.chars)) +
          "</b></div>",
      )
      .join("") +
    "</div>"
  );
}
function reportDailyTotals() {
  const totals = {};
  Object.values(allReadingStats()).forEach((value) =>
    Object.entries(value.daily || {}).forEach(([key, time]) => {
      const row = totals[key] || (totals[key] = { seconds: 0, chars: 0 });
      const seconds = Number(time) || 0;
      row.seconds += seconds;
      row.chars += Number(value.dailyChars?.[key] || (seconds * 500) / 60);
    }),
  );
  return totals;
}
function reportTrend(scale) {
  const totals = reportDailyTotals(),
    period = reportPeriod(scale),
    buckets = [];
  if (scale === "week") {
    for (let i = 0; i < 7; i++) {
      const date = new Date(period.start);
      date.setDate(date.getDate() + i);
      const key = reportDateKey(date),
        row = totals[key] || { seconds: 0, chars: 0 };
      buckets.push({
        label: ["一", "二", "三", "四", "五", "六", "日"][i],
        ...row,
      });
    }
  } else if (scale === "month") {
    const weeks = Math.ceil(period.end.getDate() / 7);
    for (let i = 0; i < weeks; i++)
      buckets.push({ label: "第" + (i + 1) + "周", seconds: 0, chars: 0 });
    Object.entries(totals).forEach(([key, row]) => {
      if (
        key >= reportDateKey(period.start) &&
        key <= reportDateKey(period.end)
      ) {
        const week = Math.floor((Number(key.slice(8, 10)) - 1) / 7);
        buckets[week].seconds += row.seconds;
        buckets[week].chars += row.chars;
      }
    });
  } else {
    for (let i = 0; i < 12; i++)
      buckets.push({ label: i + 1 + "月", seconds: 0, chars: 0 });
    Object.entries(totals).forEach(([key, row]) => {
      if (key.startsWith(String(period.start.getFullYear()) + "-")) {
        const month = Number(key.slice(5, 7)) - 1;
        buckets[month].seconds += row.seconds;
        buckets[month].chars += row.chars;
      }
    });
  }
  const max = Math.max(60, ...buckets.map((row) => row.seconds));
  return (
    '<div class="report-trend">' +
    buckets
      .map(
        (row) =>
          '<div class="report-column" title="' +
          formatReadingTime(row.seconds) +
          " · " +
          reportChars(row.chars) +
          '"><b>' +
          (row.seconds ? formatReadingTime(row.seconds) : "") +
          '</b><i style="height:' +
          Math.max(4, Math.round((row.seconds / max) * 135)) +
          'px"></i><small>' +
          row.label +
          "</small></div>",
      )
      .join("") +
    "</div>"
  );
}
function renderReadingReport(scale = "day") {
  const content = document.getElementById("readingReportContent"),
    entries = reportEntries(scale),
    categories = reportCategories(entries),
    totalSeconds = entries.reduce((sum, item) => sum + item.seconds, 0),
    totalChars = entries.reduce((sum, item) => sum + item.chars, 0),
    completed = entries.reduce((sum, item) => sum + item.completed, 0),
    period = reportPeriod(scale),
    today = new Date(),
    periodLabels = {
      day: "今日阅读",
      week: "本星期阅读",
      month: today.getMonth() + 1 + "月阅读",
      year: today.getFullYear() + "年阅读",
    };
  document
    .querySelectorAll(".report-scale-tab")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.reportScale === scale),
    );
  if (!entries.length) {
    content.innerHTML =
      '<div class="report-period"><div><h3>' +
      periodLabels[scale] +
      "</h3><p>" +
      reportDateKey(period.start) +
      (scale === "day" ? "" : " — " + reportDateKey(period.end)) +
      '</p></div></div><div class="report-empty">这一时间段还没有阅读记录。打开书架中的书籍开始阅读后，成果会自动出现在这里。</div>';
    return;
  }
  let metrics, body;
  if (scale === "day") {
    metrics = [
      ["今日阅读", entries.length + "本"],
      ["涉及领域", categories.length + "类"],
      ["专注时长", formatReadingTime(totalSeconds)],
      ["估算阅读", reportChars(totalChars)],
    ];
    body =
      '<div class="report-grid"><section class="report-panel"><h4>今天读了哪些书</h4>' +
      reportBookRows(entries, 12) +
      '</section><section class="report-panel"><h4>今日时间分配</h4>' +
      reportDistribution(entries) +
      "</section></div>";
  } else if (scale === "week") {
    const activeDays = new Set();
    Object.values(allReadingStats()).forEach((value) =>
      Object.keys(value.daily || {}).forEach((key) => {
        if (
          key >= reportDateKey(period.start) &&
          key <= reportDateKey(period.end) &&
          (value.daily[key] || 0) > 0
        )
          activeDays.add(key);
      }),
    );
    metrics = [
      ["本周阅读", entries.length + "本"],
      ["活跃天数", activeDays.size + "天"],
      ["阅读时长", formatReadingTime(totalSeconds)],
      ["估算阅读", reportChars(totalChars)],
    ];
    body =
      '<div class="report-grid"><section class="report-panel"><h4>七日阅读节奏</h4>' +
      reportTrend("week") +
      '</section><section class="report-panel"><h4>本周领域分布</h4>' +
      reportDistribution(categories) +
      '</section><section class="report-panel report-wide"><h4>本周投入最多的书</h4>' +
      reportBookRows(entries, 6) +
      "</section></div>";
  } else if (scale === "month") {
    metrics = [
      ["本月阅读", entries.length + "本"],
      ["领域覆盖", categories.length + "类"],
      ["阅读时长", formatReadingTime(totalSeconds)],
      ["已标记章节", completed + "章"],
    ];
    body =
      '<div class="report-grid"><section class="report-panel"><h4>每周阅读走势</h4>' +
      reportTrend("month") +
      '</section><section class="report-panel"><h4>各领域阅读字数</h4>' +
      reportDistribution(categories, "chars") +
      '</section><section class="report-panel report-wide"><h4>本月书籍明细</h4>' +
      reportBookRows(entries, 10) +
      "</section></div>";
  } else {
    metrics = [
      ["今年读过", entries.length + "本"],
      ["知识领域", categories.length + "类"],
      ["累计阅读", reportChars(totalChars)],
      ["阅读时长", formatReadingTime(totalSeconds)],
    ];
    body =
      '<div class="report-grid"><section class="report-panel report-wide"><h4>十二个月的阅读轨迹</h4>' +
      reportTrend("year") +
      '</section><section class="report-panel"><h4>年度投入最多的书</h4>' +
      reportBookRows(entries, 8) +
      '</section><section class="report-panel"><h4>年度知识版图</h4><table class="report-category-table"><thead><tr><th>类别</th><th>书籍</th><th>阅读量</th><th>时长</th></tr></thead><tbody>' +
      categories
        .map(
          (row) =>
            "<tr><td>" +
            escapeHtml(row.category) +
            "</td><td>" +
            row.books.size +
            "本</td><td>" +
            reportChars(row.chars) +
            "</td><td>" +
            formatReadingTime(row.seconds) +
            "</td></tr>",
        )
        .join("") +
      "</tbody></table></section></div>";
  }
  const topCategory = categories[0]?.category || "尚未形成",
    guidance = {
      day: [
        totalSeconds >= 1200
          ? "今天已经形成一次完整的专注阅读。"
          : "今天的阅读足迹正在建立，短时持续也很有价值。",
        totalSeconds >= 1200
          ? "下一次可用一句话记录本章最重要的收获。"
          : "先完成一次 15–20 分钟阅读，优先延续当前书籍。",
      ],
      week: [
        "本周的主要投入集中在“" + topCategory + "”，可以看出当前阅读主线。",
        categories.length < 2
          ? "保持主线，同时加入一个相邻领域，让知识结构更有层次。"
          : "保持当前频率，并把投入最多的一本书推进到明确章节节点。",
      ],
      month: [
        "本月覆盖 " + categories.length + " 个领域，主线是“" + topCategory + "”。",
        entries.length > 3
          ? "下月建议挑一本主线书做更深推进，减少同时铺开的数量。"
          : "围绕当前主线补一本相邻领域书，逐步扩展知识地图。",
      ],
      year: [
        "今年已经读过 " + entries.length + " 本书，“" + topCategory + "”构成最清晰的知识主线。",
        categories.length < 3
          ? "在稳定主线之外增加一到两个相邻领域，形成更完整的年度版图。"
          : "选择年度投入最高的一本书复盘，把批注整理成自己的主题笔记。",
      ],
    }[scale];
  content.innerHTML =
    '<div class="report-period"><div><h3>' +
    periodLabels[scale] +
    "</h3><p>" +
    reportDateKey(period.start) +
    (scale === "day" ? "" : " — " + reportDateKey(period.end)) +
    '</p></div></div><div class="report-metrics">' +
    metrics.map((item) => reportMetric(item[0], item[1])).join("") +
    "</div>" +
    body +
    '<section class="report-panel report-guidance"><h4>成就与方向</h4><p>' +
    escapeHtml(guidance[0]) +
    '</p><strong>下一步</strong><p>' +
    escapeHtml(guidance[1]) +
    "</p></section>" +
    '<p class="report-note">阅读报告仅保存在本机。旧记录未保存逐字进度时，阅读字数会根据阅读时长估算；新版记录会持续积累更细的数据。</p>';
}
const readingReportModal = document.getElementById("readingReportModal");
document.getElementById("readingReportButton").onclick = () => {
  rememberReadingMeta();
  openExclusiveModal(readingReportModal);
  renderReadingReport("day");
};
document.getElementById("closeReadingReport").onclick = () =>
  readingReportModal.classList.remove("open");
readingReportModal.addEventListener("click", (event) => {
  if (event.target === readingReportModal)
    readingReportModal.classList.remove("open");
});
document
  .querySelectorAll(".report-scale-tab")
  .forEach(
    (button) =>
      (button.onclick = () => renderReadingReport(button.dataset.reportScale)),
  );
const profileModal = document.getElementById("profileModal"),
  profileButton = document.getElementById("profileButton"),
  profileNameInput = document.getElementById("profileNameInput"),
  profileAvatarInput = document.getElementById("profileAvatarInput");
let pendingProfileAvatar = "";
function validProfileAvatar(value) {
  return (
    typeof value === "string" &&
    /^data:image\/(?:png|jpeg|webp);base64,/i.test(value)
  );
}
function setProfileVisual(element, name, avatar) {
  element.replaceChildren();
  element.classList.toggle("has-image", validProfileAvatar(avatar));
  if (validProfileAvatar(avatar)) {
    const image = document.createElement("img");
    image.src = avatar;
    image.alt = "";
    element.appendChild(image);
  } else element.textContent = name || "读者";
}
function updateProfilePreview() {
  const name = profileNameInput.value.trim() || "读者",
    hasAvatar = validProfileAvatar(pendingProfileAvatar);
  setProfileVisual(
    document.getElementById("profilePreviewAvatar"),
    name,
    pendingProfileAvatar,
  );
  const previewName = document.getElementById("profilePreviewName");
  previewName.textContent = name;
  previewName.hidden = hasAvatar;
  document.getElementById("profilePreviewHint").textContent = hasAvatar
    ? "已优先使用图片头像"
    : "没有头像时完整显示名称";
  document.getElementById("removeProfileAvatar").hidden = !hasAvatar;
}
function applyLocalProfile() {
  const name =
      (localStorage.getItem("yuejian-profile-name") || "陈").trim() || "陈",
    avatar = localStorage.getItem("yuejian-profile-avatar") || "";
  setProfileVisual(profileButton, name, avatar);
  profileButton.title = name + " · 设置本地用户";
  profileButton.setAttribute("aria-label", "当前用户 " + name + "，点击修改");
  profileNameInput.value = name;
  pendingProfileAvatar = validProfileAvatar(avatar) ? avatar : "";
  updateProfilePreview();
}
applyLocalProfile();
const accountModeText = document.getElementById("accountModeText"),
  accountSyncBadge = document.getElementById("accountSyncBadge"),
  accountLoginFields = document.getElementById("accountLoginFields"),
  accountConnectedActions = document.getElementById("accountConnectedActions"),
  accountSyncDetails = document.getElementById("accountSyncDetails");
function syncTimeLabel(value) {
  if (!value) return "尚未完成同步";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
function renderAccountStatus(status = {}) {
  const account = status.mode === "account";
  accountLoginFields.hidden = account;
  accountConnectedActions.hidden = !account;
  accountSyncBadge.className = "sync-status-badge";
  if (!account) {
    accountSyncBadge.classList.add("local");
    accountSyncBadge.textContent = "本地模式";
    accountModeText.textContent = "数据只保存在这台电脑，不会访问同步服务器";
    accountSyncDetails.textContent = "";
    return;
  }
  const failed = Boolean(status.lastError), pending = Number(status.pendingChanges || 0);
  accountSyncBadge.classList.add(failed ? "offline" : pending ? "offline" : "synced");
  accountSyncBadge.textContent = failed ? "离线待同步" : pending ? `待同步 ${pending} 条` : "已同步";
  accountModeText.textContent = `${status.username || "账户"} · 已连接独立同步服务器`;
  const s=status.lastSyncSummary||{}, summary=(s.uploadedBooks||s.downloadedBooks||s.uploadedItems||s.downloadedItems)?`<br>上次结果：上传 ${s.uploadedBooks||0} 本书 / ${s.uploadedItems||0} 条信息，下载 ${s.downloadedBooks||0} 本书 / ${s.downloadedItems||0} 条信息`:'';
  accountSyncDetails.innerHTML = `<b>${failed ? "本地数据安全保留" : "账户模式已启用"}</b><br>最近同步：${escapeHtml(syncTimeLabel(status.lastSyncAt))}<br>待同步：${pending} 条${summary}${failed ? `<br>状态：${escapeHtml(status.lastError)}` : ""}`;
}
let desktopSyncTimer;
function startDesktopSyncProgress(label="正在同步账户数据") {
  const box=document.getElementById("desktopSyncProgress"),phase=document.getElementById("desktopSyncPhase"),percent=document.getElementById("desktopSyncPercent"),bar=document.getElementById("desktopSyncBar"),counts=document.getElementById("desktopSyncCounts");
  box.hidden=false; phase.textContent=label; counts.textContent="正在整理书架、阅读记录与批注…"; let value=6; bar.style.width=value+"%"; percent.textContent=value+"%"; clearInterval(desktopSyncTimer);
  desktopSyncTimer=setInterval(()=>{value=Math.min(92,value+Math.max(1,Math.round((94-value)/7)));bar.style.width=value+"%";percent.textContent=value+"%";phase.textContent=value<30?"正在整理本机数据":value<65?"正在上传并交换阅读信息":"正在核对并下载远端书籍";},500);
}
function finishDesktopSyncProgress(result={},error="") {
  clearInterval(desktopSyncTimer); const box=document.getElementById("desktopSyncProgress"),phase=document.getElementById("desktopSyncPhase"),percent=document.getElementById("desktopSyncPercent"),bar=document.getElementById("desktopSyncBar"),counts=document.getElementById("desktopSyncCounts");
  phase.textContent=error?"同步未完成":"同步完成"; percent.textContent=error?"!":"100%"; bar.style.width="100%"; counts.textContent=error?error:`上传 ${result.uploadedBooks||result.uploadedBlobs||0} 本书 / ${result.uploadedItems||result.uploaded||0} 条信息 · 下载 ${result.downloadedBooks||result.downloadedBlobs||0} 本书 / ${result.downloadedItems||result.downloaded||0} 条信息`; if(!error)setTimeout(()=>box.hidden=true,4500);
}
async function accountApi(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "账户操作失败");
  return result;
}
async function loadAccountStatus() {
  try {
    const response = await fetch("/api/account/status", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取同步状态");
    const status = await response.json();
    renderAccountStatus(status);
    if (status.username) document.getElementById("accountUsername").value = status.username;
  } catch (error) {
    accountModeText.textContent = error.message;
    accountSyncBadge.className = "sync-status-badge error";
    accountSyncBadge.textContent = "状态异常";
  }
}
async function submitAccount(register) {
  const serverUrl = "http://127.0.0.1:18787",
    username = document.getElementById("accountUsername").value.trim(),
    passwordField = document.getElementById("accountPassword"),
    password = passwordField.value;
  if (!username || password.length < 8) {
    showNotice("请填写用户名和至少 8 位密码。", true);
    return;
  }
  const buttons = [document.getElementById("accountLogin"), document.getElementById("accountRegister")];
  buttons.forEach((button) => button.disabled = true);
  startDesktopSyncProgress(register ? "正在注册并同步已有数据" : "正在登录并同步已有数据");
  accountModeText.textContent = register ? "正在创建账户…" : "正在登录并交换本地数据…";
  try {
    const status = await accountApi(register ? "/api/account/register" : "/api/account/login", { serverUrl, username, password, deviceName: "Windows Desktop" });
    passwordField.value = "";
    renderAccountStatus(status);
    finishDesktopSyncProgress(status.sync||{});
    await refreshPersistentStorage();
    applyLocalProfile();
    showNotice(status.lastError ? "账户已登录，服务器暂时离线；本地数据会在下次连接时同步。" : "登录成功，多端阅读数据已同步。", Boolean(status.lastError));
  } catch (error) {
    finishDesktopSyncProgress({},error.message);
    showNotice(error.message, true);
    await loadAccountStatus();
  } finally {
    buttons.forEach((button) => button.disabled = false);
  }
}
document.getElementById("accountLogin").onclick = () => submitAccount(false);
document.getElementById("accountRegister").onclick = () => submitAccount(true);
document.getElementById("syncNow").onclick = async () => {
  const button = document.getElementById("syncNow");
  button.disabled = true; button.textContent = "正在同步…";
  startDesktopSyncProgress("正在同步账户数据");
  try {
    const result = await accountApi("/api/sync/now");
    await refreshPersistentStorage();
    applyLocalProfile();
    await loadAccountStatus();
    finishDesktopSyncProgress(result);
    showNotice(`同步完成：上传 ${result.uploadedBlobs || 0} 本书 / ${result.uploaded || 0} 条信息，下载 ${result.downloadedBlobs || 0} 本书 / ${result.downloaded || 0} 条信息。`);
  } catch (error) {
    finishDesktopSyncProgress({},error.message);
    showNotice(`${error.message}。本地数据已保留，服务器恢复后可继续同步。`, true);
    await loadAccountStatus();
  } finally {
    button.disabled = false; button.textContent = "立即同步";
  }
};
document.getElementById("accountLogout").onclick = async () => {
  try {
    renderAccountStatus(await accountApi("/api/account/logout"));
    showNotice("已切换为本地模式，本机书籍和阅读数据均已保留。");
  } catch (error) { showNotice(error.message, true); }
};
async function loadLocalStoragePaths() {
  try {
    const response = await fetch("/api/storage/status", { cache: "no-store" }), data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取本机保存位置");
    document.getElementById("desktopBookPath").textContent = data.bookPath || "本机应用数据目录";
    document.getElementById("desktopBookmarkPath").textContent = data.bookmarkPath || "下载 / 阅见书签";
  } catch (error) {
    document.getElementById("desktopBookPath").textContent = "暂时无法读取";
    document.getElementById("desktopBookmarkPath").textContent = "下载 / 阅见书签";
  }
}
profileButton.onclick = () => {
  applyLocalProfile();
  loadAccountStatus();
  loadLocalStoragePaths();
  openExclusiveModal(profileModal);
  setTimeout(() => {
    profileNameInput.focus();
    profileNameInput.select();
  }, 50);
};
loadAccountStatus();
document.getElementById("cancelProfile").onclick = () =>
  profileModal.classList.remove("open");
profileModal.addEventListener("click", (event) => {
  if (event.target === profileModal) profileModal.classList.remove("open");
});
profileNameInput.addEventListener("input", updateProfilePreview);
document.getElementById("removeProfileAvatar").onclick = () => {
  pendingProfileAvatar = "";
  profileAvatarInput.value = "";
  updateProfilePreview();
};
profileAvatarInput.addEventListener("change", () => {
  const file = profileAvatarInput.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showNotice("头像图片不能超过 10 MB。", true);
    profileAvatarInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const side = Math.min(image.width, image.height),
        sx = (image.width - side) / 2,
        sy = (image.height - side) / 2,
        canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, 256, 256);
      context.drawImage(image, sx, sy, side, side, 0, 0, 256, 256);
      pendingProfileAvatar = canvas.toDataURL("image/jpeg", 0.86);
      updateProfilePreview();
    };
    image.onerror = () => showNotice("无法读取这张头像图片。", true);
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});
document.getElementById("saveProfile").onclick = () => {
  const name = profileNameInput.value.trim();
  if (!name) {
    showNotice("请输入用户名称。", true);
    profileNameInput.focus();
    return;
  }
  localStorage.setItem("yuejian-profile-name", name);
  if (validProfileAvatar(pendingProfileAvatar))
    localStorage.setItem("yuejian-profile-avatar", pendingProfileAvatar);
  else localStorage.removeItem("yuejian-profile-avatar");
  applyLocalProfile();
  profileModal.classList.remove("open");
  showNotice("本地用户资料已保存。");
};
profileNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") document.getElementById("saveProfile").click();
});
document.getElementById("askButton").addEventListener("click", ask);
document.getElementById("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter") ask();
});

initializeAccessibility(analysisConfirmModal);
