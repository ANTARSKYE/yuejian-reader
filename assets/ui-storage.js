const nativeSet = Storage.prototype.setItem;
const nativeRemove = Storage.prototype.removeItem;
const nativeClear = Storage.prototype.clear;

let saveTimer = null;
let dirty = false;
let pendingPatch = {};

async function persist(keepalive = false) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const patch = pendingPatch;
  pendingPatch = {};
  dirty = false;
  if (!Object.keys(patch).length) return;
  try {
    const response = await fetch("/api/ui-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch }),
      keepalive,
    });
    if (!response.ok) throw new Error("界面设置保存失败");
  } catch (error) {
    pendingPatch = { ...patch, ...pendingPatch };
    dirty = true;
    console.warn("界面设置保存失败", error);
  }
}

function queue(key, value) {
  pendingPatch[String(key)] = value;
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist(), 500);
}

export async function initializePersistentStorage() {
  try {
    const response = await fetch("/api/ui-state", { cache: "no-store" });
    if (response.ok) {
      const state = (await response.json()).state || {};
      Object.entries(state).forEach(([key, value]) => {
        if (key.startsWith("yuejian-") && typeof value === "string")
          nativeSet.call(localStorage, key, value);
      });
    }
  } catch (error) {
    console.warn("界面设置恢复失败", error);
  }

  Storage.prototype.setItem = function (key, value) {
    nativeSet.call(this, key, value);
    if (this === localStorage && String(key).startsWith("yuejian-"))
      queue(key, String(value));
  };
  Storage.prototype.removeItem = function (key) {
    nativeRemove.call(this, key);
    if (this === localStorage && String(key).startsWith("yuejian-"))
      queue(key, null);
  };
  Storage.prototype.clear = function () {
    if (this === localStorage) {
      for (let index = 0; index < this.length; index += 1) {
        const key = this.key(index);
        if (key?.startsWith("yuejian-")) pendingPatch[key] = null;
      }
    }
    nativeClear.call(this);
    if (this === localStorage) {
      dirty = true;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persist(), 500);
    }
  };
  window.addEventListener("pagehide", () => {
    if (dirty) persist(true);
  });
}
