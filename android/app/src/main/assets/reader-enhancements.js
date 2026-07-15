(() => {
  const A = window.app, F = window.features;
  if (!A || !F) return;
  if (!Yuejian.readingStatsAsync) Yuejian.readingStatsAsync = requestId => setTimeout(() => A.nativeResult(JSON.stringify({requestId, ok:true, result:parse(Yuejian.readingStats(), [])})), 20);
  if (!Yuejian.syncStatus) Yuejian.syncStatus = () => JSON.stringify({mode:'local',pendingChanges:0,lastSyncAt:0,lastError:''});
  if (!Yuejian.accountLoginAsync) Yuejian.accountLoginAsync = (requestId, serverUrl, username) => setTimeout(() => A.nativeResult(JSON.stringify({requestId,ok:true,result:{mode:'account',serverUrl,username,pendingChanges:0,lastSyncAt:Date.now(),lastError:''}})), 30);
  if (!Yuejian.syncNowAsync) Yuejian.syncNowAsync = requestId => setTimeout(() => A.nativeResult(JSON.stringify({requestId,ok:true,result:{mode:'account',ok:true,uploaded:0,downloaded:0,pendingChanges:0}})), 30);
  if (!Yuejian.accountLogoutAsync) Yuejian.accountLogoutAsync = requestId => setTimeout(() => A.nativeResult(JSON.stringify({requestId,ok:true,result:{mode:'local',pendingChanges:0}})), 30);
  const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
  const esc = value => A.escape(value ?? '');
  const readState = (key, fallback) => parse(Yuejian.getState(key, JSON.stringify(fallback)), fallback);
  const saveState = (key, value) => Yuejian.setState(key, JSON.stringify(value));
  const pending = new Map();
  const oldNativeResult = A.nativeResult;
  A.nativeResult = payload => {
    const event = typeof payload === 'string' ? parse(payload, {}) : payload;
    const task = pending.get(event.requestId);
    if (!task) return oldNativeResult(payload);
    pending.delete(event.requestId);
    event.ok ? task.resolve(event.result) : task.reject(new Error(event.error || '操作失败'));
  };
  const nativeAsync = (method, ...args) => new Promise((resolve, reject) => {
    if (typeof Yuejian[method] !== 'function') {
      const sync = method.replace(/Async$/, '');
      try { const value=Yuejian[sync](...args); resolve(typeof value==='string'?parse(value,value):value); }
      catch (error) { reject(error); }
      return;
    }
    const id = 'ux-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    pending.set(id, {resolve, reject});
    try { Yuejian[method](id, ...args); } catch (error) { pending.delete(id); reject(error); }
  });
  const formatTime = seconds => seconds < 60 ? `${Math.round(seconds)} 秒` : seconds < 3600 ? `${Math.round(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;

  const originalInit = F.init.bind(F);
  F.init = function () {
    originalInit();
    A.showAbout = () => A.toast('阅见 Android 1.2.3 · AI 报告跨端同步');
    this.installReadingExperience();
    this.installAnnotationUi();
    this.installNavigationFeedback();
    this.installAccountSync();
    this.installBackgroundPicker();
    this.installProfilePicker();
  };

  F.installBackgroundPicker = function () {
    const input=document.getElementById('backgroundFile'); if(!input||document.getElementById('backgroundPicker'))return;
    input.classList.add('background-file-native');
    const picker=document.createElement('button'); picker.type='button'; picker.id='backgroundPicker'; picker.className='background-picker';
    picker.innerHTML='<span class="background-picker-icon">▧</span><span><b>选择背景图片</b><small id="backgroundFileName">支持 JPG、PNG、WebP，自动压缩适配</small></span><em>浏览</em>';
    input.insertAdjacentElement('afterend',picker); picker.onclick=()=>input.click();
    input.addEventListener('change',()=>{const file=input.files?.[0];if(file)document.getElementById('backgroundFileName').textContent=file.name;});
    const clear=document.getElementById('clearBackground'); if(clear){clear.classList.add('background-clear');clear.textContent='恢复主题默认背景';}
  };

  F.installProfilePicker = function () {
    const input=document.getElementById('avatarFile'); if(!input||document.getElementById('avatarPicker'))return;
    input.classList.add('profile-file-native');
    const picker=document.createElement('button'); picker.type='button'; picker.id='avatarPicker'; picker.className='profile-picker';
    picker.innerHTML='<span class="profile-picker-icon">◉</span><span><b>更换本地头像</b><small id="avatarFileName">选择 JPG、PNG 或 WebP 图片</small></span><em>选择图片</em>';
    input.insertAdjacentElement('afterend',picker); picker.onclick=()=>input.click();
    input.addEventListener('change',()=>{const file=input.files?.[0];if(file)document.getElementById('avatarFileName').textContent=file.name;});
  };

  F.installNavigationFeedback = function () {
    document.querySelectorAll('.app-nav button').forEach(button => {
      button.onclick = event => { event.preventDefault(); this.showPage(button.dataset.page); };
      button.addEventListener('pointerdown', () => {
        button.classList.add('pressed');
        this.previewPage(button.dataset.page);
        if (navigator.vibrate) navigator.vibrate(10);
      }, {passive: true});
      button.addEventListener('pointerup', () => button.classList.remove('pressed'), {passive: true});
      button.addEventListener('pointercancel', () => button.classList.remove('pressed'), {passive: true});
      button.addEventListener('touchend', event => { event.preventDefault(); button.classList.remove('pressed'); this.showPage(button.dataset.page); }, {passive:false});
    });
  };
  F.previewPage = function (page) {
    ['report', 'catalog', 'profile'].forEach(name => document.getElementById(name + 'Page').classList.toggle('hidden', name !== page));
    document.getElementById('library').classList.toggle('hidden', page !== 'library');
    document.querySelectorAll('.app-nav button').forEach(button => button.classList.toggle('active', button.dataset.page === page));
    if (page === 'report') document.getElementById('reportContent').innerHTML = '<div class="page-feedback"><i></i><strong>正在打开阅读报告</strong><span>数据正在后台整理，请稍候…</span></div>';
    if (page === 'catalog') document.getElementById('sourceGrid').innerHTML = '<div class="page-feedback"><i></i><strong>正在打开在线书库</strong><span>正在载入常用书源…</span></div>';
  };
  F.showPage = function (page) {
    this.previewPage(page);
    requestAnimationFrame(() => setTimeout(() => {
      try {
        if (page === 'report') this.renderReport(this.reportScale || 'day');
        if (page === 'catalog') this.renderSources();
        if (page === 'profile') { this.loadSettings(); this.renderQuotes(); this.renderStorage(); this.renderAccountStatus(); }
      } catch(error) {
        const target=page==='report'?document.getElementById('reportContent'):page==='catalog'?document.getElementById('sourceGrid'):null;
        if(target)target.innerHTML=`<div class="page-feedback error"><strong>页面加载失败</strong><span>${esc(error.message)}</span><button onclick="features.showPage('${page}')">重新打开</button></div>`;
      }
    }, 0));
  };

  F.installAccountSync = function () {
    const column = document.querySelector('#profilePage .settings-grid > div:first-child');
    if (!column || document.getElementById('androidAccountPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'androidAccountPanel'; panel.className = 'panel account-panel';
    panel.innerHTML = `<div class="account-title"><div><h3>账户与同步</h3><p>不登录也可完整使用；服务器关闭时继续本地阅读。</p></div><span id="androidSyncBadge" class="account-badge local">本地模式</span></div>
      <p class="panel-desc">登录后同步书架资料、进度、统计、批注、标记、书签和阅读偏好。AI 密钥不会同步。</p>
      <div id="androidSyncProgress" class="account-sync-progress hidden"><div><b id="androidSyncPhase">准备同步…</b><span id="androidSyncPercent">0%</span></div><div class="account-progress-track"><i id="androidSyncProgressBar"></i></div><p id="androidSyncCounts">上传 0 本书 / 0 条信息 · 下载 0 本书 / 0 条信息</p></div>
      <div id="androidAccountLogin"><p class="account-auto-discovery">先在电脑上双击“阅见同步服务器.exe”。手机与电脑处于同一 Wi-Fi 时会自动连接。</p><label class="field"><span>用户名</span><input id="androidUsername" maxlength="40" autocomplete="username"></label><label class="field"><span>密码（至少 8 位）</span><input id="androidPassword" type="password" maxlength="200" autocomplete="current-password"></label><div class="row wrap"><button class="small-action" id="androidRegister">注册</button><button class="action" id="androidLogin">登录并同步</button></div></div>
      <div id="androidAccountConnected" hidden><div id="androidSyncDetails" class="account-details"></div><div class="row wrap"><button class="action" id="androidSyncNow">立即同步</button><button class="small-action" id="androidLogout">退出登录</button></div></div>`;
    column.insertBefore(panel, column.querySelector('.panel:nth-child(2)'));
    document.getElementById('androidLogin').onclick = () => this.submitAccount(false);
    document.getElementById('androidRegister').onclick = () => this.submitAccount(true);
    document.getElementById('androidSyncNow').onclick = () => this.syncAccountNow();
    document.getElementById('androidLogout').onclick = async () => { try { this.applyAccountStatus(await nativeAsync('accountLogoutAsync')); A.toast('已切换为本地模式，本机数据已保留'); } catch(error) { A.toast(error.message); } };
    this.renderAccountStatus();
  };
  F.renderAccountStatus = function () {
    try { this.applyAccountStatus(parse(Yuejian.syncStatus(), {mode:'local'})); }
    catch (error) { this.applyAccountStatus({mode:'local',lastError:error.message}); }
  };
  F.applyAccountStatus = function (status) {
    const account = status?.mode === 'account', error = status?.lastError || status?.error || '', pendingCount = +(status?.pendingChanges || 0);
    const login = document.getElementById('androidAccountLogin'), connected = document.getElementById('androidAccountConnected'), badge = document.getElementById('androidSyncBadge');
    if (!login || !connected || !badge) return;
    login.hidden = account; connected.hidden = !account;
    const modeBadge=document.querySelector('#profilePage .sync-badge');
    if(modeBadge)modeBadge.innerHTML=`<i></i>${!account?'本地模式':error?'账户模式 · 离线待同步':'账户模式 · 已连接'}`;
    badge.className = 'account-badge ' + (!account ? 'local' : error || pendingCount ? 'offline' : 'synced');
    badge.textContent = !account ? '本地模式' : error ? '离线待同步' : pendingCount ? `待同步 ${pendingCount} 条` : '已同步';
    if (account) {
      const s=status.lastSyncSummary||{}, summary=(s.uploadedBlobs||s.downloadedBlobs||s.uploaded||s.downloaded)?`<br>上次结果：上传 ${s.uploadedBlobs||0} 本书 / ${s.uploaded||0} 条信息，下载 ${s.downloadedBlobs||0} 本书 / ${s.downloaded||0} 条信息`:'';
      document.getElementById('androidSyncDetails').innerHTML = `<b>${esc(status.username || '账户模式')}</b><br>最近同步：${status.lastSyncAt ? new Date(+status.lastSyncAt).toLocaleString('zh-CN') : '尚未完成'}<br>待同步：${pendingCount} 条${summary}${error ? `<br>状态：${esc(error)}` : ''}`;
      if (status.username) document.getElementById('androidUsername').value = status.username;
    }
  };
  F.submitAccount = async function (register) {
    const server = '', username = document.getElementById('androidUsername').value.trim(), passwordField = document.getElementById('androidPassword'), password = passwordField.value;
    if (!username || password.length < 8) return A.toast('请填写用户名和至少 8 位密码');
    const buttons = [document.getElementById('androidLogin'), document.getElementById('androidRegister')]; buttons.forEach(button => button.disabled = true);
    this.accountSyncProgress({phase:'discovering',done:0,total:1,uploadedItems:0,downloadedItems:0,uploadedBooks:0,downloadedBooks:0});
    try { const status = await nativeAsync('accountLoginAsync', server, username, password, !!register); passwordField.value = ''; this.applyAccountStatus(status); this.applySyncedState(); const sync=status.sync||{}; A.toast(sync.ok===false ? `账户已连接；${sync.error||'数据将在服务器恢复后同步'}` : '账户已连接，多端数据同步完成'); }
    catch (error) { A.toast(error.message); this.renderAccountStatus(); }
    finally { buttons.forEach(button => button.disabled = false); }
  };
  F.syncAccountNow = async function () {
    const button = document.getElementById('androidSyncNow'); button.disabled = true; button.textContent = '正在同步…';
    this.accountSyncProgress({phase:'preparing',done:0,total:1,uploadedItems:0,downloadedItems:0,uploadedBooks:0,downloadedBooks:0});
    try { const result = await nativeAsync('syncNowAsync'); this.renderAccountStatus(); this.applySyncedState(); A.toast(result.ok ? `同步完成：上传 ${result.uploaded || 0} 条，接收 ${result.downloaded || 0} 条` : result.error); }
    catch (error) { A.toast(error.message); this.renderAccountStatus(); }
    finally { button.disabled = false; button.textContent = '立即同步'; }
  };
  F.accountSyncFinished = function (payload) { const result = typeof payload === 'string' ? parse(payload,{}) : payload; this.renderAccountStatus(); if (result?.ok) this.applySyncedState(); };
  F.accountSyncProgress = function (payload) {
    const data=typeof payload==='string'?parse(payload,{}):payload||{}, box=document.getElementById('androidSyncProgress'); if(!box)return;
    const labels={discovering:'正在寻找电脑服务器',reconnecting:'连接变化，正在重新发现服务器',preparing:'正在整理本机数据',exchanging:'正在同步阅读信息',uploadingBooks:'正在上传书籍原文',downloadingBooks:'正在下载书籍原文',complete:'同步完成'};
    const total=Math.max(1,Number(data.total)||1),done=Math.max(0,Number(data.done)||0),percent=data.phase==='complete'?100:Math.min(96,Math.round(done/total*100));
    box.classList.remove('hidden'); document.getElementById('androidSyncPhase').textContent=labels[data.phase]||'正在同步'; document.getElementById('androidSyncPercent').textContent=percent+'%'; document.getElementById('androidSyncProgressBar').style.width=percent+'%';
    document.getElementById('androidSyncCounts').textContent=`上传 ${data.uploadedBooks||0} 本书 / ${data.uploadedItems||0} 条信息 · 下载 ${data.downloadedBooks||0} 本书 / ${data.downloadedItems||0} 条信息`;
    if(data.phase==='complete')setTimeout(()=>box.classList.add('hidden'),3500);
  };
  F.applySyncedState = function () {
    const theme = Yuejian.getState('yuejian-theme', '');
    if (theme && ['starry','cat','paper','green','white','night','blue','parchment'].includes(theme)) A.setTheme(theme);
    this.loadSettings(); this.applyProfile(); this.renderLibrary();
    if (!document.getElementById('reportPage')?.classList.contains('hidden')) this.renderReport(this.reportScale || 'day');
  };

  F.installReadingExperience = function () {
    const setting = document.createElement('div');
    setting.className = 'setting';
    setting.innerHTML = '<label><span>翻阅方式</span><span id="readingFlowLabel">连续滑动</span></label><div class="reading-flow-switch"><button data-flow="scroll">连续滑动</button><button data-flow="page">左右翻页</button></div>';
    document.querySelector('#settingsSheet .sheet').insertBefore(setting, document.querySelector('#settingsSheet .setting:last-of-type'));
    document.querySelectorAll('[data-flow]').forEach(button => button.onclick = () => this.setReadingFlow(button.dataset.flow));
    this.readingFlow = readState('readingFlow', 'scroll');
    this.setReadingFlow(this.readingFlow, false);
    const oldLoad = A.loadChapter.bind(A);
    A.loadChapter = async (index, savePrevious = true) => {
      this.continuousLoading = false;
      await oldLoad(index, savePrevious);
    };
    const oldClose = A.closeReader.bind(A);
    A.closeReader = () => { this.resetReadingLayout(); oldClose(); };
    A.nextChapter = () => this.readingFlow === 'page' ? this.turnPage(1) : this.scrollToAdjacent(1);
    A.prevChapter = () => this.readingFlow === 'page' ? this.turnPage(-1) : this.scrollToAdjacent(-1);
  };
  F.setReadingFlow = function (mode, persist = true) {
    this.readingFlow = mode === 'page' ? 'page' : 'scroll';
    if (persist) saveState('readingFlow', this.readingFlow);
    document.body.classList.toggle('reader-page-mode', this.readingFlow === 'page');
    document.querySelectorAll('[data-flow]').forEach(button => button.classList.toggle('active', button.dataset.flow === this.readingFlow));
    const label = document.getElementById('readingFlowLabel'); if (label) label.textContent = this.readingFlow === 'page' ? '左右翻页' : '连续滑动';
    if (A.book) A.loadChapter(A.chapter, false);
  };
  F.resetReadingLayout = function () {
    const reading = document.getElementById('reading'), scroll = document.getElementById('readingScroll');
    reading.classList.remove('page-layout'); reading.style.width = ''; reading.style.columnWidth = ''; reading.style.columnGap = ''; scroll.onscroll = null; scroll.scrollLeft = 0;
    this.pageResizeObserver?.disconnect(); this.pageResizeObserver = null;
    this.pageIndex = 0; this.pageCount = 1; this.continuousLoading = false; this.prependLoading = false;
  };
  F.afterChapterLoad = function () {
    this.resetReadingLayout();
    if (this.readingFlow === 'page') this.setupPageMode(); else this.setupContinuousMode();
  };
  F.createChapterSection = function (index, data, existingNodes) {
    const section = document.createElement('section');
    section.className = 'continuous-chapter'; section.dataset.chapter = index;
    section.innerHTML = `<div class="chapter-divider"><span>${index + 1} / ${A.book.chapters.length}</span><strong>${esc(data?.title || A.book.chapters[index].title)}</strong></div>`;
    if (existingNodes) section.append(...existingNodes);
    else {
      const temp = document.createElement('div'); A.renderContent(temp, data.html, data.base); section.append(...temp.childNodes);
    }
    this.decorateRoot(section, index); return section;
  };
  F.setupContinuousMode = function () {
    const host = document.getElementById('reading'), scroll = document.getElementById('readingScroll');
    const nodes = [...host.childNodes]; host.replaceChildren(this.createChapterSection(A.chapter, null, nodes));
    this.loadedFrom = A.chapter; this.loadedThrough = A.chapter;
    scroll.onscroll = () => {
      clearTimeout(this.continuousScrollTimer);
      this.continuousScrollTimer = setTimeout(() => this.onContinuousScroll(), 35);
    };
    this.prependPreviousChapter(); this.appendNextChapter();
  };
  F.appendNextChapter = function () {
    if (this.continuousLoading || !A.book || this.loadedThrough >= A.book.chapters.length - 1) return;
    this.continuousLoading = true;
    requestAnimationFrame(() => setTimeout(async () => {
      try {
        const next = this.loadedThrough + 1, data = await nativeAsync('readChapterAsync', A.book.id, next);
        if (!data.error) { document.getElementById('reading').append(this.createChapterSection(next, data)); this.loadedThrough = next; }
      } finally { this.continuousLoading = false; }
    }, 0));
  };
  F.prependPreviousChapter = function () {
    if (this.prependLoading || !A.book || this.loadedFrom <= 0) return;
    this.prependLoading = true;
    requestAnimationFrame(() => setTimeout(async () => {
      const scroll = document.getElementById('readingScroll'), oldHeight = scroll.scrollHeight;
      try {
        const previous = this.loadedFrom - 1, data = await nativeAsync('readChapterAsync', A.book.id, previous);
        if (!data.error) {
          document.getElementById('reading').prepend(this.createChapterSection(previous, data));
          this.loadedFrom = previous;
          scroll.scrollTop += scroll.scrollHeight - oldHeight;
        }
      } finally { this.prependLoading = false; }
    }, 0));
  };
  F.onContinuousScroll = function () {
    const scroll = document.getElementById('readingScroll');
    if (scroll.scrollTop < Math.max(500, scroll.clientHeight * .7)) this.prependPreviousChapter();
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < Math.max(700, scroll.clientHeight)) this.appendNextChapter();
    const sections = [...document.querySelectorAll('.continuous-chapter')];
    let active = sections[0];
    for (const section of sections) if (section.offsetTop - scroll.scrollTop < 150) active = section;
    const index = +(active?.dataset.chapter || A.chapter);
    if (index !== A.chapter) {
      A.chapter = index;
      document.getElementById('readerChapterTitle').textContent = A.book.chapters[index].title;
      document.getElementById('chapterPage').textContent = `${index + 1} / ${A.book.chapters.length}`;
      document.getElementById('prevBtn').disabled = index === 0;
      document.getElementById('nextBtn').disabled = index === A.book.chapters.length - 1;
      A.updateToc(); this.refreshBookmark(); this.updateCompleted();
    }
    A.saveProgress();
  };
  F.scrollToAdjacent = function (direction) {
    const target = document.querySelector(`.continuous-chapter[data-chapter="${A.chapter + direction}"]`);
    if (target) target.scrollIntoView({behavior:'smooth', block:'start'});
    else if (A.chapter + direction >= 0 && A.chapter + direction < A.book.chapters.length) A.loadChapter(A.chapter + direction);
  };
  F.setupPageMode = function () {
    const host = document.getElementById('reading'), scroll = document.getElementById('readingScroll');
    host.classList.add('page-layout'); this.pageIndex = 0;
    const layout = () => {
      const style = getComputedStyle(scroll), gap = 36,
        width = Math.max(280, scroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      host.style.width = width + 'px'; host.style.columnWidth = width + 'px'; host.style.columnGap = gap + 'px';
      this.pageStep = width + gap; this.pageCount = Math.max(1, Math.ceil((host.scrollWidth + gap) / this.pageStep));
      this.pageIndex = Math.min(this.pageIndex, this.pageCount - 1); this.updatePage(false);
    };
    requestAnimationFrame(layout);
    this.pageResizeObserver?.disconnect(); this.pageResizeObserver = new ResizeObserver(layout); this.pageResizeObserver.observe(scroll);
    let startX = 0, startY = 0;
    scroll.ontouchstart = event => { const t = event.touches[0]; startX = t.clientX; startY = t.clientY; };
    scroll.ontouchend = event => { const t = event.changedTouches[0], dx = t.clientX - startX, dy = t.clientY - startY; if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) this.turnPage(dx < 0 ? 1 : -1); };
  };
  F.turnPage = async function (direction) {
    if (direction > 0 && this.pageIndex < this.pageCount - 1) this.pageIndex++;
    else if (direction < 0 && this.pageIndex > 0) this.pageIndex--;
    else {
      const chapter = A.chapter + direction;
      if (chapter >= 0 && chapter < A.book.chapters.length) {
        await A.loadChapter(chapter);
        if (direction < 0) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          this.pageIndex = Math.max(0, this.pageCount - 1); this.updatePage(false);
        }
      }
      return;
    }
    this.updatePage(); A.saveProgress();
  };
  F.updatePage = function (smooth = true) {
    document.getElementById('readingScroll').scrollTo({left:this.pageIndex * (this.pageStep || 0),behavior:smooth?'smooth':'auto'});
    document.getElementById('chapterPage').textContent = `${A.chapter + 1}/${A.book.chapters.length} · ${this.pageIndex + 1}/${this.pageCount}`;
  };

  F.installAnnotationUi = function () {
    document.getElementById('selectionTools').innerHTML = '<button data-action="copy">复制</button><button data-action="share">分享书签</button><button data-action="paragraph">段落全选</button><button data-action="translate">翻译</button><span class="tool-divider"></span><button data-action="note">批注</button><button class="color amber" data-action="amber" aria-label="黄色高亮"></button><button class="color red" data-action="red" aria-label="红色高亮"></button><button class="color blue" data-action="blue" aria-label="蓝色高亮"></button><button class="color green" data-action="green" aria-label="绿色高亮"></button><button data-action="ai">AI 解析</button><button data-action="cancel" aria-label="关闭">×</button>';
    document.getElementById('selectionTools').onclick = event => {
      const action = event.target.dataset.action; if (!action) return;
      if (['amber','red','blue','green'].includes(action)) this.saveSelection(action, '');
      if (action === 'copy') this.copySelection();
      if (action === 'share') this.shareSelection();
      if (action === 'paragraph') this.selectWholeParagraph();
      if (action === 'translate') this.translateSelection();
      if (action === 'note') this.openAnnotationEditor(null, this.selectionInfo);
      if (action === 'ai') this.explainSelection();
      if (action === 'cancel') { getSelection().removeAllRanges(); this.hideSelection(); }
    };
    document.body.insertAdjacentHTML('beforeend', '<div id="annotationSheet" class="annotation-sheet hidden"><div class="annotation-card"><div class="annotation-head"><div><strong id="annotationTitle">添加批注</strong><span id="annotationQuote"></span></div><button id="annotationClose">×</button></div><textarea id="annotationText" placeholder="写下你的理解、疑问或联想…"></textarea><div class="annotation-colors"><button data-annotation-color="amber">黄色</button><button data-annotation-color="red">红色</button><button data-annotation-color="blue">蓝色</button><button data-annotation-color="green">绿色</button></div><div class="annotation-actions"><button id="annotationDelete" class="danger hidden">删除标记</button><button id="annotationSave" class="action">保存</button></div><div id="annotationList" class="annotation-list hidden"></div></div></div>');
    document.getElementById('annotationClose').onclick = () => this.closeAnnotationEditor();
    document.getElementById('annotationSave').onclick = () => this.commitAnnotation();
    document.getElementById('annotationDelete').onclick = () => this.deleteCurrentAnnotation();
    document.querySelectorAll('[data-annotation-color]').forEach(button => button.onclick = () => { this.annotationColor = button.dataset.annotationColor; this.updateAnnotationColors(); });
    document.getElementById('reading').addEventListener('click', event => { const mark = event.target.closest('[data-annotation-id]'); if (mark) this.openAnnotationById(mark.dataset.annotationId); });
    A.addNote = () => this.openAnnotationList();
  };
  F.selectionChanged = function () {
    if (this.mode !== 'text' || !A.book) return;
    const selection = getSelection(), text = String(selection).trim();
    if (text.length < 1 || !document.getElementById('reading').contains(selection.anchorNode)) { if (!text) this.hideSelection(); return; }
    const range = selection.getRangeAt(0), rects = [...range.getClientRects()].filter(item=>item.width&&item.height&&item.bottom>0&&item.top<innerHeight), rect = rects[rects.length-1] || range.getBoundingClientRect(), anchor = selection.anchorNode?.nodeType===3?selection.anchorNode.parentElement:selection.anchorNode, section = anchor?.closest?.('.continuous-chapter');
    this.selection = text.slice(0, 4000);
    const root = section || document.getElementById('reading'), locator = this.selectionLocator(root, range, this.selection);
    this.selectionInfo = {quote:this.selection, chapter:section ? +section.dataset.chapter : A.chapter, ...locator};
    const tools = document.getElementById('selectionTools'); tools.classList.remove('hidden');
    const left = Math.max(12, Math.min(innerWidth - tools.offsetWidth - 12, rect.left + rect.width / 2 - tools.offsetWidth / 2));
    const top = rect.top > 100 ? rect.top - tools.offsetHeight - 10 : rect.bottom + 10;
    tools.style.left = left + 'px'; tools.style.top = Math.max(8, top) + 'px'; tools.style.bottom = 'auto'; tools.style.transform = 'none';
  };
  F.currentSelectionText = function () { return this.selectionInfo?.quote || this.selection || String(getSelection()).trim(); };
  F.copySelection = function () {
    const text = this.currentSelectionText(); if (!text) return;
    if (Yuejian.copyText) Yuejian.copyText(text); else navigator.clipboard?.writeText(text);
  };
  F.shareBookmarkText = function () {
    const quote = this.currentSelectionText(), chapter = this.selectionInfo?.chapter ?? A.chapter,
      chapterTitle = A.book?.chapters?.[chapter]?.title || `第 ${chapter + 1} 章`,
      stamp = new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date());
    return `《${A.book?.title || '未命名书籍'}》\n${chapterTitle}\n\n“${quote}”\n\n摘录于 阅见 · ${stamp}`;
  };
  F.shareSelection = function () {
    const quote = this.currentSelectionText(); if (!quote) return;
    const chapter = this.selectionInfo?.chapter ?? A.chapter, item = {id:'share-'+Date.now().toString(36),bookId:A.book.id,bookTitle:A.book.title,chapter,chapterTitle:A.book.chapters[chapter]?.title||'',quote,created:Date.now()};
    const saved = readState('shareBookmarks',[]); saved.unshift(item); saveState('shareBookmarks',saved.slice(0,300));
    const text = this.shareBookmarkText();
    if (Yuejian.shareText) Yuejian.shareText('《'+A.book.title+'》阅读书签', text); else navigator.share?.({title:A.book.title,text});
  };
  F.selectWholeParagraph = function () {
    const selection = getSelection(); if (!selection.rangeCount) return;
    const node = selection.getRangeAt(0).commonAncestorContainer, element = node.nodeType===3 ? node.parentElement : node,
      block = element?.closest?.('p,li,blockquote,h1,h2,h3,h4,h5,h6,figcaption,td,th');
    if (!block || !document.getElementById('reading').contains(block)) return A.toast('当前位置没有可全选的段落');
    const range = document.createRange(); range.selectNodeContents(block); selection.removeAllRanges(); selection.addRange(range); this.selectionChanged();
  };
  F.translateSelection = async function () {
    const quote = this.currentSelectionText(); if (!quote) return;
    this.hideSelection(); this.showReaderMode('qa');
    document.getElementById('qaList').insertAdjacentHTML('beforeend',`<div class="qa-msg user">翻译选段：${esc(quote.slice(0,300))}</div><div class="qa-msg ai pending">翻译中…</div>`);
    const target=document.getElementById('qaList').lastElementChild;
    try { target.textContent=await nativeAsync('translateSelection',A.book.id,quote); } catch(error) { target.textContent=error.message; }
  };
  F.selectionLocator = function (root, range, quote) {
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:node=>node.parentElement.closest('.chapter-divider,.annotation-note,.reader-mark')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
    let node,text='',start=-1;while(node=walker.nextNode()){if(node===range.startContainer)start=text.length+range.startOffset;text+=node.data}
    if(start<0)start=text.indexOf(quote);const raw=String(getSelection()),leading=Math.max(0,raw.indexOf(quote));start=Math.max(0,start+leading);const end=start+quote.length;
    return {start,end,prefix:text.slice(Math.max(0,start-48),start),suffix:text.slice(end,end+48)};
  };
  F.decorateChapter = function () { if (A.book) this.decorateRoot(document.getElementById('reading'), A.chapter); };
  F.decorateRoot = function (root, chapter) {
    root.querySelectorAll('.reader-mark').forEach(mark => mark.replaceWith(...mark.childNodes));
    const notes = parse(Yuejian.annotations(A.book.id), []).filter(item => item.chapter === chapter);
    notes.forEach(note => this.applyTextMark(root, note));
  };
  F.applyTextMark = function (root, note) {
    const nodes = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {acceptNode: node => node.parentElement.closest('.chapter-divider,.annotation-note,.reader-mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    let node, text = ''; while (node = walker.nextNode()) { nodes.push({node,start:text.length,end:text.length + node.data.length}); text += node.data; }
    let at = Number.isInteger(note.start) && note.start >= 0 && text.slice(note.start, note.start + note.quote.length) === note.quote ? note.start : -1;
    if (at < 0 && note.prefix) { const probe = note.prefix + note.quote + (note.suffix || ''), found=text.indexOf(probe); if(found>=0)at=found+note.prefix.length; }
    if (at < 0) at = text.indexOf(note.quote); if (at < 0) return;
    const end = at + note.quote.length, segments = nodes.filter(item => item.end > at && item.start < end).reverse();
    segments.forEach(item => { const from=Math.max(0,at-item.start),to=Math.min(item.node.data.length,end-item.start); const range=document.createRange();range.setStart(item.node,from);range.setEnd(item.node,to);const mark=document.createElement('mark');mark.className=`reader-mark ${note.color || 'amber'}`;mark.dataset.annotationId=note.id;range.surroundContents(mark); });
  };
  F.saveSelection = function (color, note) {
    if (!this.selectionInfo?.quote) return;
    const saved = parse(Yuejian.saveAnnotation(A.book.id, JSON.stringify({...this.selectionInfo, color, note})), {});
    if (saved.error) return A.toast(saved.error);
    getSelection().removeAllRanges(); this.hideSelection(); A.loadChapter(A.chapter, false); A.toast(note ? '批注已保存' : '高亮已保存');
  };
  F.openAnnotationEditor = function (item, selection) {
    this.currentAnnotation = item || null; this.pendingAnnotation = selection || null; this.annotationColor = item?.color || 'amber';
    document.getElementById('annotationTitle').textContent = item ? '编辑阅读标记' : '添加批注';
    document.getElementById('annotationQuote').textContent = item?.quote || selection?.quote || '';
    document.getElementById('annotationText').value = item?.note || '';
    document.getElementById('annotationDelete').classList.toggle('hidden', !item);
    document.getElementById('annotationList').classList.add('hidden'); this.updateAnnotationColors();
    document.getElementById('annotationSheet').classList.remove('hidden');
    setTimeout(() => document.getElementById('annotationText').focus(), 80);
  };
  F.updateAnnotationColors = function () { document.querySelectorAll('[data-annotation-color]').forEach(button => button.classList.toggle('active', button.dataset.annotationColor === this.annotationColor)); };
  F.commitAnnotation = function () {
    const base = this.currentAnnotation || this.pendingAnnotation; if (!base?.quote) return;
    const result = parse(Yuejian.saveAnnotation(A.book.id, JSON.stringify({...base, note:document.getElementById('annotationText').value.trim(), color:this.annotationColor})), {});
    if (result.error) return A.toast(result.error);
    this.closeAnnotationEditor(); getSelection().removeAllRanges(); A.loadChapter(A.chapter, false); A.toast('阅读标记已保存');
  };
  F.deleteCurrentAnnotation = function () { if (!this.currentAnnotation) return; Yuejian.deleteAnnotation(this.currentAnnotation.id); this.closeAnnotationEditor(); A.loadChapter(A.chapter, false); A.toast('标记已删除'); };
  F.openAnnotationById = function (id) { const item=parse(Yuejian.annotations(A.book.id),[]).find(note=>note.id===id); if(item)this.openAnnotationEditor(item); };
  F.openAnnotationList = function () {
    const notes=parse(Yuejian.annotations(A.book.id),[]).filter(note=>note.chapter===A.chapter),sheet=document.getElementById('annotationSheet'),list=document.getElementById('annotationList');
    this.currentAnnotation=null;this.pendingAnnotation=null;document.getElementById('annotationTitle').textContent='本章批注与高亮';document.getElementById('annotationQuote').textContent=`共 ${notes.length} 条`;document.getElementById('annotationText').classList.add('hidden');document.querySelector('.annotation-colors').classList.add('hidden');document.querySelector('.annotation-actions').classList.add('hidden');
    list.classList.remove('hidden');list.innerHTML=notes.length?notes.map(note=>`<button data-open-annotation="${note.id}"><i class="${note.color}"></i><span>${esc(note.quote.slice(0,90))}<small>${esc(note.note||'仅高亮')}</small></span></button>`).join(''):'<p>本章还没有批注或高亮。长按选择文字即可添加。</p>';
    list.onclick=event=>{const button=event.target.closest('[data-open-annotation]');if(button){this.restoreAnnotationEditorLayout();this.openAnnotationById(button.dataset.openAnnotation)}};sheet.classList.remove('hidden');
  };
  F.restoreAnnotationEditorLayout = function(){document.getElementById('annotationText').classList.remove('hidden');document.querySelector('.annotation-colors').classList.remove('hidden');document.querySelector('.annotation-actions').classList.remove('hidden')};
  F.closeAnnotationEditor = function(){document.getElementById('annotationSheet').classList.add('hidden');this.restoreAnnotationEditorLayout();this.currentAnnotation=null;this.pendingAnnotation=null;};

  F.reportLine = function (values, labels) {
    const max=Math.max(1,...values),points=values.map((v,i)=>`${20+i*(560/Math.max(1,values.length-1))},${145-v/max*110}`).join(' ');
    return `<div class="line-chart"><svg viewBox="0 0 600 170" role="img"><line x1="20" y1="145" x2="580" y2="145"></line><polyline points="${points}"></polyline>${values.map((v,i)=>`<circle cx="${20+i*(560/Math.max(1,values.length-1))}" cy="${145-v/max*110}" r="5"><title>${formatTime(v)}</title></circle>`).join('')}</svg><div>${labels.map(x=>`<span>${esc(x)}</span>`).join('')}</div></div>`;
  };
  F.reportDonut = function (domains, total) {
    const colors=['#79a9ff','#ffd783','#78c5a5','#f09a91','#b99cff'],parts=[];let angle=0;
    domains.slice(0,5).forEach((row,i)=>{const next=angle+row.seconds/Math.max(1,total)*360;parts.push(`${colors[i]} ${angle}deg ${next}deg`);angle=next});
    return `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${parts.join(',')||'#334b78 0 360deg'})"><b>${domains.length}</b><span>阅读领域</span></div><div class="donut-legend">${domains.slice(0,5).map((row,i)=>`<div><i style="background:${colors[i]}"></i><span>${esc(row.name)}</span><b>${Math.round(row.seconds/Math.max(1,total)*100)}%</b></div>`).join('')}</div></div>`;
  };
  F.reportGauge = function (seconds) { const percent=Math.min(100,Math.round(seconds/3600*100));return `<div class="focus-gauge" style="--focus:${percent*3.6}deg"><div><b>${formatTime(seconds)}</b><span>今日专注</span></div></div><p class="gauge-caption">${percent>=100?'已完成一小时深度阅读，今天的专注很扎实。':`距离一小时专注目标还差 ${formatTime(Math.max(0,3600-seconds))}。`}</p>`; };
  F.reportTable = function (books) { return `<div class="report-table-wrap"><table class="report-table"><thead><tr><th>书籍</th><th>领域</th><th>时长</th><th>阅读量</th></tr></thead><tbody>${books.map(book=>`<tr><td>${esc(book.name)}</td><td>${esc(book.domain)}</td><td>${formatTime(book.seconds)}</td><td>${book.chars.toLocaleString()} 字</td></tr>`).join('')||'<tr><td colspan="4">这个周期还没有阅读记录</td></tr>'}</tbody></table></div>`; };
  F.renderReport = async function (period) {
    this.reportScale=period;const box=document.getElementById('reportContent');box.setAttribute('aria-busy','true');
    try {
      const rows=await nativeAsync('readingStatsAsync'),range=this.reportRange(period),start=this.dateKey(range.start),end=this.dateKey(range.end),filtered=rows.filter(r=>r.day>=start&&r.day<=end),bookMap=new Map(),domainMap=new Map();
      filtered.forEach(row=>{const name=row.title||'已删除书籍',domain=this.reportDomain(name),book=bookMap.get(row.bookId)||{name,domain,seconds:0,chars:0};book.seconds+=+row.seconds||0;book.chars+=+row.chars||0;bookMap.set(row.bookId,book);const d=domainMap.get(domain)||{name:domain,seconds:0};d.seconds+=+row.seconds||0;domainMap.set(domain,d)});
      const books=[...bookMap.values()].sort((a,b)=>b.seconds-a.seconds),domains=[...domainMap.values()].sort((a,b)=>b.seconds-a.seconds),seconds=filtered.reduce((a,b)=>a+(+b.seconds||0),0),chars=filtered.reduce((a,b)=>a+(+b.chars||0),0),days=new Set(filtered.map(x=>x.day)).size;
      let buckets=[],labels=[];
      if(period==='day'){buckets=[seconds];labels=['今日'];}
      if(period==='week'){for(let i=0;i<7;i++){const d=new Date(range.start);d.setDate(d.getDate()+i);const key=this.dateKey(d);buckets.push(filtered.filter(x=>x.day===key).reduce((a,b)=>a+(+b.seconds||0),0));labels.push(['一','二','三','四','五','六','日'][i]);}}
      if(period==='month'){const count=Math.ceil(range.end.getDate()/7);for(let i=0;i<count;i++){buckets.push(filtered.filter(x=>Math.floor((+x.day.slice(8)-1)/7)===i).reduce((a,b)=>a+(+b.seconds||0),0));labels.push(`第${i+1}周`);}}
      if(period==='year'){for(let i=1;i<=12;i++){buckets.push(filtered.filter(x=>+x.day.slice(5,7)===i).reduce((a,b)=>a+(+b.seconds||0),0));labels.push(`${i}月`);}}
      const title={day:'今日阅读画像',week:'本周阅读节奏',month:'本月阅读趋势',year:'年度阅读版图'}[period],top=domains[0]?.name||'尚未形成';
      box.innerHTML=`<div class="report-period-label">${title} · ${start}${period==='day'?'':' — '+end}</div><div class="metric-grid report-metrics"><div class="metric"><b>${formatTime(seconds)}</b><span>专注时长</span></div><div class="metric"><b>${chars.toLocaleString()}</b><span>估算字数</span></div><div class="metric"><b>${books.length} 本</b><span>阅读书籍</span></div><div class="metric"><b>${days} 天</b><span>活跃天数</span></div></div><div class="report-visual-grid"><section class="panel"><h3>${period==='day'?'今日专注进度':'时间走势'}</h3>${period==='day'?this.reportGauge(seconds):this.reportLine(buckets,labels)}</section><section class="panel"><h3>知识领域分布</h3>${this.reportDonut(domains,seconds)}</section></div><section class="panel"><h3>书籍投入明细</h3>${this.reportTable(books)}</section>${this.reportInsight('成就与方向',seconds?`当前主要阅读方向是${top}，已累计专注 ${formatTime(seconds)}。`:'这一周期还没有形成阅读记录。',days<3?'先建立三个固定阅读时段，让节奏比单次时长更稳定。':domains.length<2?'保持主线，并加入一个相邻领域扩展知识结构。':'选择投入最多的一本书做阶段复盘，把高亮整理为主题笔记。')}<p class="panel-desc report-footnote">折线图用于观察节奏变化，环形图展示领域结构，表格保留书籍级明细；数据仅保存在本机。</p>`;
    } catch(error){box.innerHTML=`<div class="page-feedback error"><strong>报告暂时没有打开</strong><span>${esc(error.message)}</span><button onclick="features.renderReport('${period}')">重新加载</button></div>`;} finally {box.removeAttribute('aria-busy');}
  };

  F.defaultQuotes = function(){return[
    {id:'tangong-stars',original:'醉后不知天在水，满船清梦压星河。',translation:'',author:'唐珙《题龙阳县青草湖》'},
    {id:'libai-stars',original:'危楼高百尺，手可摘星辰。',translation:'',author:'李白《夜宿山寺》'},
    {id:'dufu-stars',original:'星垂平野阔，月涌大江流。',translation:'',author:'杜甫《旅夜书怀》'},
    {id:'kant-cosmos',original:'Zwei Dinge erfüllen das Gemüt mit immer neuer und zunehmender Bewunderung und Ehrfurcht: der bestirnte Himmel über mir und das moralische Gesetz in mir.',translation:'有两样东西，愈思考愈令人敬畏：我头顶的星空和我心中的道德法则。',author:'Immanuel Kant《Kritik der praktischen Vernunft》'},
    {id:'dante-stars',original:'L’amor che move il sole e l’altre stelle.',translation:'那推动太阳和群星运转的爱。',author:'Dante Alighieri《Paradiso》'},
    {id:'whitman-stars',original:'I believe a leaf of grass is no less than the journey-work of the stars.',translation:'我相信，一片草叶并不逊于群星运行的伟业。',author:'Walt Whitman《Song of Myself》'},
    {id:'keats-star',original:'Bright star, would I were stedfast as thou art—',translation:'明亮的星啊，但愿我能像你一样坚定不移。',author:'John Keats《Bright star》'},
    {id:'shakespeare-music',original:'If music be the food of love, play on.',translation:'如果音乐是爱情的食粮，那就继续奏下去吧。',author:'William Shakespeare《Twelfth Night》'},
    {id:'nietzsche-music',original:'Ohne Musik wäre das Leben ein Irrtum.',translation:'没有音乐，生命将是一个错误。',author:'Friedrich Nietzsche《Götzen-Dämmerung》'}
  ]};
  F.quotes = function(){let list=readState('quotes',null);if(!readState('quotesAlignedV3',false)){const ids=new Set(this.defaultQuotes().map(x=>x.id)),custom=Array.isArray(list)?list.filter(x=>!ids.has(x.id)&&!String(x.id||'').startsWith('builtin-')):[];list=[...this.defaultQuotes(),...custom];saveState('quotes',list);saveState('quotesAlignedV3',true)}return Array.isArray(list)&&list.length?list:this.defaultQuotes()};
  F.renderQuote = function(){const list=this.quotes(),last=readState('quoteLast',{}),pool=list.filter(x=>x.id!==last.last),pick=list.find(x=>x.id===last.pinned)||pool[Math.floor(Math.random()*Math.max(1,pool.length))]||list[0];if(!pick)return;document.querySelector('.hero h2').textContent=pick.original||pick.text;document.querySelector('.hero p').textContent=(pick.translation?pick.translation+' · ':'—— ')+pick.author;saveState('quoteLast',{...last,last:pick.id})};
  F.renderQuotes = function(){
    const prefs=readState('quoteLast',{}),all=this.quotes(),size=5,pages=Math.max(1,Math.ceil(all.length/size));
    this.quotePage=Math.max(0,Math.min(Number(this.quotePage)||0,pages-1));
    const rows=all.slice(this.quotePage*size,(this.quotePage+1)*size).map(q=>`<div class="quote-row"><blockquote>${esc(q.original||q.text)}${q.translation?`<em>${esc(q.translation)}</em>`:''}</blockquote><small>${esc(q.author)}</small><div class="row"><button class="small-action" onclick="features.pinQuote('${q.id}')">${prefs.pinned===q.id?'已固定':'固定首页'}</button><button class="small-action" onclick="features.deleteQuote('${q.id}')">删除</button></div></div>`).join('');
    document.getElementById('quoteList').innerHTML=`<div class="quote-page-list">${rows}</div><div class="quote-pagination"><button class="small-action" ${this.quotePage===0?'disabled':''} onclick="features.changeQuotePage(-1)">上一页</button><span>第 ${this.quotePage+1} / ${pages} 页 · 共 ${all.length} 条</span><button class="small-action" ${this.quotePage>=pages-1?'disabled':''} onclick="features.changeQuotePage(1)">下一页</button></div>`;
  };
  F.changeQuotePage=function(step){this.quotePage=(Number(this.quotePage)||0)+step;this.renderQuotes();document.getElementById('quoteList')?.scrollIntoView({behavior:'smooth',block:'start'});};

  A.showAbout = () => A.toast('阅见 Android 1.2.3 · AI 报告跨端同步');
})();
