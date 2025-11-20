'use strict';

const CLICK_AND_LOAD_SETTING_KEY = 'CLICKNLOAD_ACTIVE';
const CONNECTION_STATE_KEY = 'MYJD_CONNECTION_ACTIVE';
const DEFAULT_TOOLBAR_WIDTH = 420;
const DEFAULT_TOOLBAR_HEIGHT = 384;
const REQUEST_QUEUE_STORAGE_KEY = 'CNL_REQUEST_QUEUE';
const REQUEST_QUEUE = {};

const LOCALHOST_PATTERNS = [
  'http://127.0.0.1:9666/*',
  'http://localhost:9666/*'
];

const FLASH_ADD_PATH = '/flash/add';
const FLASH_ADD_CRYPTED_PATH = '/flash/addcrypted2';
const JDCHECK_PATH = '/jdcheck.js';
const CROSS_DOMAIN_PATH = '/crossdomain.xml';
const FROM_EXTENSION_FLAG = '?fromExtension';

let clickAndLoadEnabled = true;
let connectionActive = true;

initializeState();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (CLICK_AND_LOAD_SETTING_KEY in changes) {
    clickAndLoadEnabled = changes[CLICK_AND_LOAD_SETTING_KEY].newValue !== false;
  }
  if (CONNECTION_STATE_KEY in changes) {
    connectionActive = changes[CONNECTION_STATE_KEY].newValue !== false;
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  handleClickAndLoadRequest,
  { urls: LOCALHOST_PATTERNS },
  ['requestBody']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.name) {
    return;
  }

  if (message.name === 'myjd-toolbar') {
    handleToolbarMessage(message, sender, sendResponse);
    return false;
  }

  if (message.name === 'close-me') {
    handleCloseMeMessage(message, sender);
    sendResponse({});
    return false;
  }

  if (message.name === 'cnl-support') {
    sendResponse({ data: { cnlSupported: true } });
    return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete REQUEST_QUEUE[tabId];
  persistQueue();
});

function initializeState() {
  chrome.storage.local.get(
    [CLICK_AND_LOAD_SETTING_KEY, CONNECTION_STATE_KEY, REQUEST_QUEUE_STORAGE_KEY],
    (result) => {
      if (chrome.runtime.lastError) {
        console.warn(chrome.runtime.lastError.message);
      }
      clickAndLoadEnabled = result[CLICK_AND_LOAD_SETTING_KEY] !== false;
      connectionActive = result[CONNECTION_STATE_KEY] !== false;
      restoreQueue(result[REQUEST_QUEUE_STORAGE_KEY]);
    }
  );
}

function handleClickAndLoadRequest(details) {
  if (!shouldProcessClickAndLoad(details.url)) {
    return;
  }

  const path = extractPath(details.url);

  if (isJdCheckPath(path)) {
    if (details.tabId >= 0) {
      injectJdCheckFlag(details.tabId);
    }
    return;
  }

  if (isCrossDomainPath(path) || isFromExtension(details.url)) {
    return;
  }

  if (isFlashAddPath(path) || isFlashAddCryptedPath(path)) {
    const clonedDetails = cloneRequestDetails(details);
    queueMicrotask(() => processFlashAddRequest(clonedDetails));
  }
}

function shouldProcessClickAndLoad(url) {
  return clickAndLoadEnabled && connectionActive && url;
}

function isFlashAddPath(path) {
  return path && path.startsWith(FLASH_ADD_PATH);
}

function isFlashAddCryptedPath(path) {
  return path && path.startsWith(FLASH_ADD_CRYPTED_PATH);
}

function isJdCheckPath(path) {
  return path && path.endsWith(JDCHECK_PATH);
}

function isCrossDomainPath(path) {
  return path && path.endsWith(CROSS_DOMAIN_PATH);
}

function isFromExtension(url) {
  return url && url.indexOf(FROM_EXTENSION_FLAG) !== -1;
}

function extractPath(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return '';
  }
}

function injectJdCheckFlag(tabId) {
  try {
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const script = document.createElement('script');
          script.text = 'window.jdownloader=true';
          (document.head || document.documentElement || document.body).appendChild(script);
        } catch (err) {
          console.warn('Failed to inject jdcheck flag', err);
        }
      }
    });
  } catch (e) {
    console.warn(e);
  }
}

async function processFlashAddRequest(details) {
  if (details.tabId === -1) {
    return;
  }

  const tab = await safeGetTab(details.tabId);
  if (!tab) {
    return;
  }

  try {
    if (details.type === 'main_frame') {
      await handleMainFrameRequest(tab, details);
    } else if (details.type === 'sub_frame') {
      await queueRequestForTab(tab, details);
      openToolbarInTab(tab.id);
    } else {
      await queueRequestForTab(tab, details);
      openToolbarInTab(tab.id);
    }
  } catch (error) {
    console.warn('Failed to process ClickAndLoad request', error);
  }
}

async function handleMainFrameRequest(tab, details) {
  const targetTab = await resolveTargetTab(tab);
  if (!targetTab) {
    return;
  }

  await queueRequestForTab(targetTab, details);

  if (targetTab.id !== tab.id) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      console.warn(e);
    }
    openToolbarPopup(targetTab.id);
  } else {
    openToolbarInTab(tab.id);
  }
}

async function resolveTargetTab(tab) {
  if (tab.openerTabId) {
    const opener = await safeGetTab(tab.openerTabId);
    if (opener) {
      return opener;
    }
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });
    if (activeTab) {
      return activeTab;
    }
  } catch (e) {
    console.warn(e);
  }

  return tab;
}

async function queueRequestForTab(tab, details) {
  const formData = details.requestBody?.formData || {};
  const cnlContent = buildCnlContent(formData);

  const parentUrl =
    tab.url && !tab.url.startsWith('chrome://newtab') ? tab.url : cnlContent.source || tab.url;

  const request = {
    id: generateRequestId(),
    type: 'cnl',
    time: Date.now(),
    parent: {
      url: parentUrl,
      title: tab.title,
      favIconUrl: tab.favIconUrl
    },
    content: cnlContent
  };

  if (!REQUEST_QUEUE[tab.id]) {
    REQUEST_QUEUE[tab.id] = [];
  }

  REQUEST_QUEUE[tab.id].push(request);
  persistQueue();
}

function buildCnlContent(formData) {
  return {
    source: firstValue(formData.source) || firstValue(formData.referer),
    package: firstValue(formData.package),
    passwords: normalizeArray(formData.passwords),
    urls: normalizeArray(formData.urls),
    jk: firstValue(formData.jk),
    crypted: normalizeArray(formData.crypted),
    custom: formData
  };
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decodeURIComponentSafe(entry));
  }
  return [decodeURIComponentSafe(value)];
}

function firstValue(value) {
  if (Array.isArray(value)) {
    return decodeURIComponentSafe(value[0]);
  }
  if (value !== undefined) {
    return decodeURIComponentSafe(value);
  }
  return undefined;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch (e) {
    return value;
  }
}

function openToolbarInTab(tabId) {
  notifyQueueChanged(tabId);
  try {
    chrome.tabs.sendMessage(tabId, { action: 'open-in-page-toolbar', tabId });
  } catch (e) {
    console.warn(e);
  }
}

function notifyQueueChanged(tabId) {
  if (!tabId && tabId !== 0) {
    return;
  }
  chrome.tabs.sendMessage(tabId, { action: 'link-info-update', tabId }, () => {
    if (chrome.runtime.lastError) {
      // ignore missing receivers
    }
  });
}

function openToolbarPopup(tabId) {
  const url = `${chrome.runtime.getURL('toolbar.html')}?id=${tabId}&popup=true`;
  const options = {
    url,
    type: 'popup',
    width: DEFAULT_TOOLBAR_WIDTH,
    height: DEFAULT_TOOLBAR_HEIGHT
  };
  chrome.windows.create(options, (createdWindow) => {
    if (chrome.runtime.lastError) {
      console.warn(chrome.runtime.lastError.message);
    }
    if (createdWindow && createdWindow.id && createdWindow.width && createdWindow.height) {
      setTimeout(() => {
        chrome.windows.update(createdWindow.id, {
          width: createdWindow.width,
          height: createdWindow.height + 1
        });
      }, 800);
    }
  });
}

function cloneRequestDetails(details) {
  return {
    url: details.url,
    method: details.method,
    tabId: details.tabId,
    type: details.type,
    timeStamp: details.timeStamp,
    requestBody: cloneRequestBody(details.requestBody)
  };
}

function cloneRequestBody(body) {
  if (!body) {
    return {};
  }
  if (body.formData) {
    const cloned = {};
    Object.keys(body.formData).forEach((key) => {
      const value = body.formData[key];
      cloned[key] = Array.isArray(value) ? value.slice(0) : [value];
    });
    return { formData: cloned };
  }
  if (body.raw && body.raw.length > 0) {
    const decoded = decodeRawRequest(body.raw);
    return {
      formData: parseFormData(decoded)
    };
  }
  return {};
}

function decodeRawRequest(buffers) {
  const chunks = [];
  buffers.forEach((buffer) => {
    if (buffer && buffer.bytes) {
      chunks.push(new Uint8Array(buffer.bytes));
    }
  });
  if (chunks.length === 0) {
    return '';
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return new TextDecoder('utf-8').decode(merged);
}

function parseFormData(body) {
  const result = {};
  if (!body) {
    return result;
  }

  body.split('&').forEach((pair) => {
    const [key, value] = pair.split('=');
    if (!key) {
      return;
    }
    const decodedKey = decodeURIComponentSafe(key);
    const decodedValue = decodeURIComponentSafe(value || '');
    if (result[decodedKey] === undefined) {
      result[decodedKey] = [decodedValue];
    } else {
      result[decodedKey].push(decodedValue);
    }
  });
  return result;
}

function handleToolbarMessage(message, sender, sendResponse) {
  const action = message.action;
  const data = message.data || {};

  switch (action) {
    case 'link-info':
      sendResponse({ data: getQueueForTab(data) });
      return;
    case 'remove-all-requests':
      clearRequestQueue(data.tabId ?? sender.tab?.id);
      sendResponse({});
      return;
    case 'remove-request':
      removeRequestFromQueue(data.tabId ?? sender.tab?.id, data.requestId);
      sendResponse({});
      return;
    case 'tab-contentscript-injected':
      if (sender.tab && sender.tab.id !== undefined) {
        delete REQUEST_QUEUE[sender.tab.id];
      }
      sendResponse({});
      return;
    case 'close-in-page-toolbar':
      closeInPageToolbar(data.tabId ?? sender.tab?.id);
      sendResponse({});
      return;
    default:
      sendResponse({});
  }
}

function handleCloseMeMessage(message, sender) {
  let tabId = message?.data?.tabId;
  if (tabId === 'self' && sender.tab && sender.tab.id) {
    tabId = sender.tab.id;
  }
  const numericTabId = Number.parseInt(tabId, 10);
  if (Number.isNaN(numericTabId)) {
    return;
  }
  chrome.tabs.get(numericTabId, (tab) => {
    if (chrome.runtime.lastError) {
      return;
    }
    chrome.tabs.remove(numericTabId, () => {
      if (chrome.runtime.lastError) {
        return;
      }
      chrome.windows.get(tab.windowId, { populate: true }, (windowInfo) => {
        if (chrome.runtime.lastError || !windowInfo) {
          return;
        }
        const remainingTabs = windowInfo.tabs || [];
        const isNewTabWindow =
          remainingTabs.length === 1 && remainingTabs[0].url === 'about:newtab';
        if (remainingTabs.length === 0 || isNewTabWindow) {
          chrome.windows.remove(windowInfo.id);
        }
      });
    });
  });
}

function clearRequestQueue(tabId) {
  const normalizedId = normalizeTabId(tabId);
  if (normalizedId === undefined) {
    return;
  }
  REQUEST_QUEUE[normalizedId] = [];
  notifyQueueChanged(normalizedId);
  persistQueue();
}

function removeRequestFromQueue(tabId, requestId) {
  const normalizedId = normalizeTabId(tabId);
  if (normalizedId === undefined) {
    return;
  }
  const queue = REQUEST_QUEUE[normalizedId] || [];
  REQUEST_QUEUE[normalizedId] = queue.filter((request) => request.id !== requestId);
  notifyQueueChanged(normalizedId);
  persistQueue();
}

function closeInPageToolbar(tabId) {
  const normalizedId = normalizeTabId(tabId);
  if (normalizedId === undefined) {
    return;
  }
  try {
    chrome.tabs.sendMessage(normalizedId, { action: 'close-in-page-toolbar', tabId: normalizedId });
  } catch (e) {
    console.warn(e);
  }
  delete REQUEST_QUEUE[normalizedId];
  persistQueue();
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}

function normalizeTabId(value) {
  const numericValue = Number.parseInt(value, 10);
  return Number.isNaN(numericValue) ? undefined : numericValue;
}

function getQueueForTab(value) {
  const tabId = normalizeTabId(value?.tabId ?? value);
  if (tabId === undefined) {
    return [];
  }
  return REQUEST_QUEUE[tabId] || [];
}

function generateRequestId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function persistQueue() {
  chrome.storage.local.set({ [REQUEST_QUEUE_STORAGE_KEY]: REQUEST_QUEUE });
}

function restoreQueue(savedQueue) {
  if (!savedQueue || typeof savedQueue !== 'object') {
    return;
  }
  Object.keys(savedQueue).forEach((key) => {
    const tabId = normalizeTabId(key);
    if (tabId === undefined) {
      return;
    }
    REQUEST_QUEUE[tabId] = savedQueue[key] || [];
  });
}

