const NODES_CONFIG = window.GH_NODES_CONFIG || { nodes: [] };

const DEFAULT_NODES = (Array.isArray(NODES_CONFIG.nodes) ? NODES_CONFIG.nodes : [])
  .filter((n) =>
    n &&
    typeof n.name === "string" && n.name.trim() &&
    (n.type === "prefix" || n.type === "replace") &&
    typeof n.url === "string" && n.url.trim()
  )
  .map((n) => ({
    name: n.name.trim(),
    type: n.type,
    url: n.url.trim(),
    enabled: n.enabled !== false,
  }));

if (DEFAULT_NODES.length === 0) {
  console.warn("[GitHub 加速] 未从 nodes.js 读取到有效节点，请检查 js/nodes.js 配置。");
}

const LATENCY_TIMEOUT = 5000;
const PROBE_FILE =
  "https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore";
const TOP_N = 5;
const AUTO_CONVERT_DEBOUNCE = 600;

let allNodes = DEFAULT_NODES.map((n) => ({ ...n }));
let activeNodes = [];
let isTesting = false;
let autoConvertTimer = null;

function detectType(url) {
  const u = url.toLowerCase();
  if (u.includes("raw.githubusercontent.com")) return "RAW";
  if (u.includes("/releases/download/"))       return "RELEASE";
  if (u.includes("/archive/"))                 return "ARCHIVE";
  if (u.includes("gist.github.com"))           return "GIST";
  if (u.endsWith(".git"))                      return "CLONE";
  if (u.includes("github.com"))                return "REPO";
  return "OTHER";
}

function tagClass(t) {
  const map = {
    RAW: "tag-raw", RELEASE: "tag-release", ARCHIVE: "tag-release",
    GIST: "tag-other", CLONE: "tag-clone", REPO: "tag-repo", OTHER: "tag-other",
  };
  return map[t] || "tag-other";
}

function transformUrl(originalUrl, node) {
  const u = originalUrl.trim();
  if (!u) return null;
  if (node.type === "prefix") return node.url + u;
  if (node.type === "replace") return u.replace("github.com", node.url);
  return null;
}

function buildProbeUrl(node) {
  if (node.type === "prefix") return node.url + PROBE_FILE;
  return "https://" + node.url + "/";
}

async function measureLatency(node) {
  const base = buildProbeUrl(node);
  const url = base + (base.includes("?") ? "&" : "?") + "_t=" + Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LATENCY_TIMEOUT);
  const start = performance.now();

  try {
    await fetch(url, {
      mode: "no-cors",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return Math.round(performance.now() - start);
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

function latencyClass(ms) {
  if (ms === null || ms === undefined) return "fail";
  if (ms < 500) return "fast";
  if (ms < 1500) return "medium";
  return "slow";
}

function formatLatency(ms) {
  if (ms === null || ms === undefined) return "超时";
  return ms + " ms";
}

async function runDetection() {
  if (isTesting) return;
  isTesting = true;

  document.getElementById("retestBtn").disabled = true;

  allNodes.forEach((n) => (n.latency = undefined));
  activeNodes = [];

  updateHint(`正在后台检测 ${allNodes.length} 个节点延时…`, "testing");
  renderSkeleton();

  await Promise.allSettled(
    allNodes.map(async (node) => {
      node.latency = await measureLatency(node);
    })
  );

  const valid = allNodes.filter((n) => typeof n.latency === "number");
  valid.sort((a, b) => a.latency - b.latency);
  activeNodes = valid.slice(0, TOP_N);
  activeNodes.forEach((n) => (n.enabled = true));

  renderActiveNodes();

  if (activeNodes.length === 0) {
    updateHint("未能检测到可用节点，请点击「重新检测」。", "fail");
    showNotification("error", "节点检测失败", "所有候选节点均未响应");
  } else {
    const fastest = activeNodes[0];
    updateHint(
      `已从 ${allNodes.length} 个节点中优选最快的 ${activeNodes.length} 个`,
      "done"
    );
    showNotification(
      "success",
      "节点优选完成",
      `最快节点：${fastest.name} · ${formatLatency(fastest.latency)}`
    );
  }

  isTesting = false;
  document.getElementById("retestBtn").disabled = false;

  const input = document.getElementById("input").value.trim();
  if (input) convert();
}

function renderSkeleton() {
  const list = document.getElementById("nodeList");
  list.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "skeleton-list";

  for (let i = 0; i < TOP_N; i++) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    row.innerHTML =
      '<div class="skeleton-bar rank"></div>' +
      '<div class="skeleton-bar name"></div>' +
      '<div class="skeleton-bar time"></div>';
    wrap.appendChild(row);
  }
  list.appendChild(wrap);
}

function renderActiveNodes() {
  const list = document.getElementById("nodeList");
  list.innerHTML = "";

  if (activeNodes.length === 0) {
    list.innerHTML =
      '<div style="padding:20px;text-align:center;font-size:13px;color:var(--text-secondary);">暂无可用节点</div>';
    return;
  }

  activeNodes.forEach((node, i) => {
    const row = document.createElement("div");
    row.className = "node-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = node.enabled;
    cb.id = `active_node_${i}`;
    cb.addEventListener("change", () => {
      activeNodes[i].enabled = cb.checked;
    });

    const rank = document.createElement("span");
    rank.className = "node-rank";
    rank.textContent = "#" + (i + 1);

    const label = document.createElement("label");
    label.htmlFor = `active_node_${i}`;
    label.textContent = node.name;

    const typeTag = document.createElement("span");
    typeTag.className = "node-type";
    typeTag.textContent = node.type === "prefix" ? "前缀" : "替换";

    const latency = document.createElement("span");
    latency.className = "node-latency " + latencyClass(node.latency);
    latency.textContent = formatLatency(node.latency);

    row.appendChild(cb);
    row.appendChild(rank);
    row.appendChild(label);
    row.appendChild(typeTag);
    row.appendChild(latency);
    list.appendChild(row);
  });
}

function updateHint(text, state) {
  const hint = document.getElementById("latencyHint");
  hint.textContent = text;
  hint.className = "panel-hint" + (state ? " " + state : "");
}

let notifTimer = null;

function showNotification(type, title, desc, duration = 5000) {
  const box = document.getElementById("notification");
  const icon = document.getElementById("notifIcon");
  const titleEl = document.getElementById("notifTitle");
  const descEl = document.getElementById("notifDesc");

  icon.className = "notif-icon";
  if (type === "error") {
    icon.classList.add("error");
    icon.textContent = "✕";
  } else if (type === "warn") {
    icon.classList.add("warn");
    icon.textContent = "!";
  } else {
    icon.textContent = "✓";
  }

  titleEl.textContent = title;
  descEl.textContent = desc;

  box.classList.remove("show");
  void box.offsetWidth;
  box.classList.add("show");

  clearTimeout(notifTimer);
  if (duration > 0) {
    notifTimer = setTimeout(() => box.classList.remove("show"), duration);
  }
}

function hideNotification() {
  clearTimeout(notifTimer);
  document.getElementById("notification").classList.remove("show");
}

function showResultCard() {
  document.getElementById("resultCard").classList.remove("is-hidden");
}

function hideResultCard() {
  document.getElementById("resultCard").classList.add("is-hidden");
}

function convert() {
  const input = document.getElementById("input").value.trim();
  if (!input) {
    showToast("请先输入 GitHub 链接");
    return;
  }

  let nodesToUse = activeNodes;
  if (nodesToUse.length === 0) {
    nodesToUse = allNodes.filter((n) => n.enabled);
    if (nodesToUse.length === 0) {
      showToast(isTesting ? "节点检测中，请稍候…" : "暂无可用节点");
      return;
    }
  }

  const lines = input
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    showToast("请先输入 GitHub 链接");
    return;
  }

  const enabledNodes = nodesToUse.filter((n) => n.enabled);
  if (enabledNodes.length === 0) {
    showToast("请至少勾选一个节点");
    return;
  }

  const resultsEl = document.getElementById("results");
  resultsEl.innerHTML = "";

  let totalCount = 0;

  lines.forEach((line, lineIdx) => {
    const type = detectType(line);

    if (lines.length > 1) {
      const groupTitle = document.createElement("div");
      groupTitle.className = "group-title";
      groupTitle.textContent = `链接 ${lineIdx + 1} · ${type}`;
      resultsEl.appendChild(groupTitle);
    }

    enabledNodes.forEach((node) => {
      const accelerated = transformUrl(line, node);
      if (!accelerated) return;
      totalCount++;
      resultsEl.appendChild(buildResultItem(node, accelerated, type));
    });
  });

  if (totalCount === 0) {
    showToast("没有生成任何加速链接");
    return;
  }

  showResultCard();
  document.getElementById("copyAllBtn").disabled = false;
  showToast(`已生成 ${totalCount} 条加速链接`);

  requestAnimationFrame(() => {
    const card = document.getElementById("resultCard");
    if (card && !card.classList.contains("is-hidden")) {
      const rect = card.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.6 || rect.bottom < 0) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  });
}

function buildResultItem(node, accelerated, type) {
  const item = document.createElement("div");
  item.className = "result-item";

  const header = document.createElement("div");
  header.className = "result-header";

  const nameEl = document.createElement("div");
  nameEl.className = "result-name";

  let html = `<span>${escapeHtml(node.name)}</span>`;
  if (typeof node.latency === "number") {
    html += `<span class="result-latency ${latencyClass(node.latency)}">${formatLatency(
      node.latency
    )}</span>`;
  }
  html += `<span class="result-tag ${tagClass(type)}">${type}</span>`;
  nameEl.innerHTML = html;

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn-copy";
  copyBtn.textContent = "复制";
  copyBtn.addEventListener("click", function () {
    copyText(accelerated, this);
  });

  header.appendChild(nameEl);
  header.appendChild(copyBtn);

  const urlEl = document.createElement("div");
  urlEl.className = "result-url";
  urlEl.textContent = accelerated;

  item.appendChild(header);
  item.appendChild(urlEl);
  return item;
}

function copyText(text, btn) {
  const onSuccess = () => {
    if (btn) {
      btn.textContent = "已复制 ✓";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "复制";
        btn.classList.remove("copied");
      }, 1500);
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
      fallbackCopy(text); onSuccess();
    });
  } else {
    fallbackCopy(text); onSuccess();
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
}

function copyAll() {
  const urls = document.querySelectorAll(".result-url");
  if (urls.length === 0) { showToast("没有可复制的内容"); return; }
  const allText = Array.from(urls).map((el) => el.textContent).join("\n");

  const btn = document.getElementById("copyAllBtn");
  const onSuccess = () => {
    btn.textContent = "已复制全部 ✓";
    setTimeout(() => { btn.textContent = "一键复制全部"; }, 1500);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(allText).then(onSuccess).catch(() => {
      fallbackCopy(allText); onSuccess();
    });
  } else {
    fallbackCopy(allText); onSuccess();
  }
}

function autoResizeTextarea(el) {
  el.style.height = "auto";
  const minH = 54;
  el.style.height = Math.max(minH, Math.min(el.scrollHeight, 180)) + "px";
}

function clearAll() {
  const input = document.getElementById("input");
  input.value = "";
  input.style.height = "";
  document.getElementById("results").innerHTML = "";
  document.getElementById("copyAllBtn").disabled = true;
  hideResultCard();
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 2000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function initFaq() {
  const items = document.querySelectorAll(".faq-item");
  items.forEach((item) => {
    item.addEventListener("toggle", () => {
      if (item.open) {
        items.forEach((other) => {
          if (other !== item && other.open) other.open = false;
        });
      }
    });
  });
}

function bindEvents() {
  const input = document.getElementById("input");
  const autoConvert = document.getElementById("autoConvert");

  input.addEventListener("input", () => {
    autoResizeTextarea(input);
  });

  input.addEventListener("input", () => {
    if (!autoConvert.checked) return;
    clearTimeout(autoConvertTimer);
    autoConvertTimer = setTimeout(() => {
      if (input.value.trim()) convert();
    }, AUTO_CONVERT_DEBOUNCE);
  });

  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      convert();
    }
  });

  document.getElementById("convertBtn").addEventListener("click", convert);
  document.getElementById("clearBtn").addEventListener("click", clearAll);
  document.getElementById("copyAllBtn").addEventListener("click", copyAll);
  document.getElementById("retestBtn").addEventListener("click", runDetection);
  document.getElementById("notifClose").addEventListener("click", hideNotification);
}

function init() {
  bindEvents();
  initFaq();
  renderSkeleton();
  updateHint(`正在后台检测 ${allNodes.length} 个节点延时…`, "testing");
  setTimeout(runDetection, 100);
}

document.addEventListener("DOMContentLoaded", init);