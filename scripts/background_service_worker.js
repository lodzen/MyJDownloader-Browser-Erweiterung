'use strict';

const CLICK_AND_LOAD_SETTING_KEY = 'CLICKNLOAD_ACTIVE';
const CONNECTION_STATE_KEY = 'MYJD_CONNECTION_ACTIVE';
const DEFAULT_TOOLBAR_WIDTH = 420;
const DEFAULT_TOOLBAR_HEIGHT = 384;
const REQUEST_QUEUE_STORAGE_KEY = 'CNL_REQUEST_QUEUE';
const REQUEST_QUEUE = {};
const SETTINGS_CLIPBOARD_OBSERVER = 'CLIPBOARD_OBSERVER';
const SETTINGS_CONTEXT_MENU_SIMPLE = 'CONTEXT_MENU_SIMPLE';

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
let clipboardObserverActive = false;

// Initialize on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Service worker: Extension installed/updated');
  await initializeState();
});

// Also initialize immediately (for when service worker wakes up)
initializeState();

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (CLICK_AND_LOAD_SETTING_KEY in changes) {
    clickAndLoadEnabled = changes[CLICK_AND_LOAD_SETTING_KEY].newValue !== false;
  }
  if (CONNECTION_STATE_KEY in changes) {
    const wasConnected = connectionActive;
    connectionActive = changes[CONNECTION_STATE_KEY].newValue !== false;
    updateBadge();
    
    // Initialize or remove context menus based on connection state
    if (connectionActive && !wasConnected) {
      // Just became connected - initialize everything
      try {
        await initSettings();
        await initMenuItems();
        await injectContentScripts();
        console.log('Initialized context menus and content scripts on connection');
      } catch (e) {
        console.warn('Failed to init menus on connection change:', e);
      }
    } else if (!connectionActive && wasConnected) {
      // Just became disconnected - clean up
      try {
        await chrome.contextMenus.removeAll();
        console.log('Removed context menus on disconnect');
      } catch (e) {
        console.warn('Failed to remove menus on disconnect:', e);
      }
    }
  }
  if (SETTINGS_CLIPBOARD_OBSERVER in changes) {
    clipboardObserverActive = changes[SETTINGS_CLIPBOARD_OBSERVER].newValue === true;
    updateBadge();
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

  // Ignore messages forwarded by this service worker to avoid loops
  if (message._fromServiceWorker) {
    return;
  }

  if (message.name === 'myjd-toolbar') {
    const result = handleToolbarMessage(message, sender, sendResponse);
    // Return true if handler needs async response, false otherwise
    return result === true;
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

// Context menu click handler
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) {
    return;
  }

  try {
    switch (info.menuItemId) {
      case 'download_page':
        // Add page URL to request queue and open toolbar
        await addPageToRequestQueue(tab);
        openToolbarInTab(tab.id);
        break;

      case 'download_selection':
        // Request selection from content script
        chrome.tabs.sendMessage(tab.id, { action: 'get-selection', tabId: tab.id });
        break;

      case 'simple_menu_item':
        // Smart menu: handle based on context
        if (info.selectionText) {
          chrome.tabs.sendMessage(tab.id, { action: 'get-selection', tabId: tab.id });
        } else if (info.linkUrl) {
          await addLinkToRequestQueue(info.linkUrl, tab);
          openToolbarInTab(tab.id);
        } else if (info.srcUrl) {
          await addLinkToRequestQueue(info.srcUrl, tab);
          openToolbarInTab(tab.id);
        } else {
          await addPageToRequestQueue(tab);
          openToolbarInTab(tab.id);
        }
        break;

      case 'download_link':
        if (info.linkUrl) {
          await addLinkToRequestQueue(info.linkUrl, tab);
          openToolbarInTab(tab.id);
        }
        break;

      case 'download_video':
      case 'download_image':
      case 'download_audio':
        if (info.srcUrl) {
          await addLinkToRequestQueue(info.srcUrl, tab);
          openToolbarInTab(tab.id);
        }
        break;
    }
  } catch (error) {
    console.warn('Context menu action failed:', error);
  }
});

// Add page URL to request queue
async function addPageToRequestQueue(tab) {
  if (!tab || !tab.id) {
    return;
  }

  const time = Date.now();
  const id = `${tab.id}-${time}-${Math.random() * 10000}`;

  if (!REQUEST_QUEUE[tab.id]) {
    REQUEST_QUEUE[tab.id] = [];
  }

  const newLink = {
    id: id,
    time: time,
    parent: {
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl
    },
    content: tab.url,
    type: 'link'
  };

  // Check for duplicates
  const existing = REQUEST_QUEUE[tab.id].find(
    (item) => item.type === 'link' && item.content === tab.url
  );

  if (!existing) {
    REQUEST_QUEUE[tab.id].push(newLink);
    persistQueue();
  }
}

// Add link URL to request queue
async function addLinkToRequestQueue(linkUrl, tab) {
  if (!tab || !tab.id || !linkUrl) {
    return;
  }

  const time = Date.now();
  const id = `${tab.id}-${time}-${Math.random() * 10000}`;

  if (!REQUEST_QUEUE[tab.id]) {
    REQUEST_QUEUE[tab.id] = [];
  }

  const newLink = {
    id: id,
    time: time,
    parent: {
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl
    },
    content: linkUrl,
    type: 'link'
  };

  // Check for duplicates
  const existing = REQUEST_QUEUE[tab.id].find(
    (item) => item.type === 'link' && item.content === linkUrl
  );

  if (!existing) {
    REQUEST_QUEUE[tab.id].push(newLink);
    persistQueue();
  }
}

async function initializeState() {
  try {
    const result = await new Promise((resolve, reject) => {
      chrome.storage.local.get(
        [CLICK_AND_LOAD_SETTING_KEY, CONNECTION_STATE_KEY, REQUEST_QUEUE_STORAGE_KEY, SETTINGS_CLIPBOARD_OBSERVER],
        (result) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(result);
          }
        }
      );
    });

    clickAndLoadEnabled = result[CLICK_AND_LOAD_SETTING_KEY] !== false;
    connectionActive = result[CONNECTION_STATE_KEY] !== false;
    clipboardObserverActive = result[SETTINGS_CLIPBOARD_OBSERVER] === true;
    restoreQueue(result[REQUEST_QUEUE_STORAGE_KEY]);
    
    console.log('Service worker initialized. Connection active:', connectionActive);
    
    // Initialize context menus and badge if already connected
    if (connectionActive) {
      try {
        await initSettings();
        await initMenuItems();
        updateBadge();
        console.log('Initialized context menus on startup - connection was already active');
      } catch (e) {
        console.error('Failed to initialize on startup:', e);
      }
    } else {
      updateBadge();
      console.log('Not connected on startup - context menus not created');
    }
  } catch (error) {
    console.error('Failed to initialize state:', error);
  }
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

// Helper function to find and send message to popup or options page
function sendMessageToPopupOrOptions(message, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Message timeout: No response from popup/options page'));
    }, timeout);

    // Use runtime messaging to communicate with extension pages
    // Extension pages (popup/options) can listen with chrome.runtime.onMessage
    chrome.runtime.sendMessage(
      { ...message, _fromServiceWorker: true },
      (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          // No extension page is listening or available
          reject(new Error('No popup or options page available'));
        } else {
          resolve(response);
        }
      }
    );
  });
}

// Broadcast session state changes to all tabs
function broadcastSessionChange(isLoggedIn) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      try {
        chrome.tabs.sendMessage(tab.id, {
          name: 'myjd-toolbar',
          action: 'session-change',
          data: { isLoggedIn }
        });
      } catch (e) {
        // Ignore errors for tabs that don't have content scripts
      }
    });
  });

  // Also send via runtime message for popup/options pages
  chrome.runtime.sendMessage({
    name: 'myjd-toolbar',
    action: 'session-change',
    data: { isLoggedIn }
  });
}

// Get session state from storage
async function getSessionStateFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CONNECTION_STATE_KEY], (result) => {
      const isLoggedIn = result[CONNECTION_STATE_KEY] === true;
      resolve(isLoggedIn);
    });
  });
}

// Update connection state in storage
function updateConnectionState(isActive) {
  connectionActive = isActive;
  chrome.storage.local.set({ [CONNECTION_STATE_KEY]: isActive });
  updateBadge();
}

// Update badge based on connection and clipboard observer state
function updateBadge() {
  const badge = { text: '', color: '' };
  
  if (!connectionActive) {
    badge.text = '!';
    badge.color = '#f3d435';
  }
  
  if (clipboardObserverActive) {
    badge.text = 'Clip';
    badge.color = '#368a8f';
  }
  
  // Update badge using MV3 chrome.action API
  if (badge.text !== undefined) {
    chrome.action.setBadgeText({ text: badge.text });
  }
  if (badge.color !== undefined && badge.color !== '') {
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } else if (badge.text === '') {
    // Clear badge color if no badge text
    chrome.action.setBadgeText({ text: '' });
  }
}

// Inject content scripts into all open tabs
async function injectContentScripts() {
  try {
    const manifest = chrome.runtime.getManifest();
    const contentScripts = manifest.content_scripts || [];
    const allScripts = [];
    
    // Collect all content script files
    contentScripts.forEach((scriptConfig) => {
      if (scriptConfig.js && Array.isArray(scriptConfig.js)) {
        allScripts.push(...scriptConfig.js);
      }
    });

    if (allScripts.length === 0) {
      return;
    }

    // Get all windows and tabs
    const windows = await chrome.windows.getAll({ populate: true });
    
    for (const window of windows) {
      if (window.tabs && window.tabs.length > 0) {
        for (const tab of window.tabs) {
          // Skip blocked URLs
          if (!tab.url || 
              (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) ||
              tab.url.startsWith('https://chrome.google.com/webstore/')) {
            continue;
          }

          // Inject all scripts
          for (const script of allScripts) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: [script]
              });
            } catch (e) {
              // Ignore errors for tabs that can't be scripted
              console.warn(`Failed to inject ${script} into tab ${tab.id}:`, e);
            }
          }
        }
      }
    }
  } catch (error) {
    console.warn('Failed to inject content scripts:', error);
  }
}

// Initialize settings from storage
async function initSettings() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get([SETTINGS_CLIPBOARD_OBSERVER, SETTINGS_CONTEXT_MENU_SIMPLE], (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        // Update clipboard observer state
        clipboardObserverActive = result[SETTINGS_CLIPBOARD_OBSERVER] === true;
        // Settings are stored, we can use them when needed
        resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Initialize context menu items
async function initMenuItems() {
  try {
    // Remove all existing menu items first
    try {
      await chrome.contextMenus.removeAll();
    } catch (e) {
      // Ignore if no menus exist
      console.log('No existing menus to remove');
    }

    // Get context menu setting
    const settings = await new Promise((resolve) => {
      chrome.storage.local.get([SETTINGS_CONTEXT_MENU_SIMPLE], (result) => {
        resolve(result || {});
      });
    });

    const isSimpleMenu = settings[SETTINGS_CONTEXT_MENU_SIMPLE] !== false; // Default to true

    if (isSimpleMenu) {
      // Simple menu: single item
      try {
        await chrome.contextMenus.create({
          id: 'simple_menu_item',
          title: chrome.i18n.getMessage('context_menu_download_with_jdownloader') || 'Download with JDownloader',
          contexts: ['all']
        });
        console.log('Created simple context menu');
      } catch (e) {
        console.error('Failed to create simple menu item:', e);
      }
    } else {
      // Full menu: multiple items
      const menuItems = [
        { id: 'download_page', title: chrome.i18n.getMessage('context_menu_add_page') || 'Add page', contexts: ['all'] },
        { id: 'download_selection', title: chrome.i18n.getMessage('context_menu_add_selection') || 'Add selection', contexts: ['selection'] },
        { id: 'download_link', title: chrome.i18n.getMessage('context_menu_add_link') || 'Add link', contexts: ['link'] },
        { id: 'download_video', title: chrome.i18n.getMessage('context_menu_add_video') || 'Add video', contexts: ['video'] },
        { id: 'download_audio', title: chrome.i18n.getMessage('context_menu_add_audio') || 'Add audio', contexts: ['audio'] },
        { id: 'download_image', title: chrome.i18n.getMessage('context_menu_add_image') || 'Add image', contexts: ['image'] }
      ];

      for (const item of menuItems) {
        try {
          await chrome.contextMenus.create(item);
        } catch (e) {
          console.error(`Failed to create menu item ${item.id}:`, e);
        }
      }
      console.log('Created full context menu');
    }
  } catch (error) {
    console.error('Failed to initialize context menu items:', error);
  }
}

// Initialize connected state (enable CNL interceptor and context menus)
async function initConnected() {
  try {
    // CNL interceptor is already set up globally, just ensure it's enabled
    // The connectionActive flag controls it
    
    // Initialize context menus
    await initMenuItems();
    
    // Update badge
    updateBadge();
  } catch (error) {
    console.warn('Failed to initialize connected state:', error);
  }
}

// Handle login success notification from popup
async function handleLoginSuccess(message, sender, sendResponse) {
  try {
    console.log('Service worker: Login success notification received');
    updateConnectionState(true);
    broadcastSessionChange(true);
    
    // Initialize settings and connected state
    try {
      await initSettings();
      await initConnected();
      await injectContentScripts();
      console.log('Service worker: Initialization after login completed');
    } catch (initError) {
      console.warn('Initialization after login failed:', initError);
    }
    
    sendResponse({ data: true });
  } catch (error) {
    console.error('Login success handler error:', error);
    sendResponse({ data: false, error: error.message });
  }
}

// Handle login failure notification from popup
async function handleLoginFailed(message, sender, sendResponse) {
  try {
    console.log('Service worker: Login failure notification received');
    updateConnectionState(false);
    broadcastSessionChange(false);
    initDisconnected().catch((e) => console.warn('initDisconnected failed:', e));
    sendResponse({ data: true });
  } catch (error) {
    console.error('Login failed handler error:', error);
    sendResponse({ data: false });
  }
}

// Handle login request (for messages from other sources like content scripts)
async function handleLogin(message, sender, sendResponse) {
  try {
    console.log('Service worker: handleLogin called', { hasData: !!message.data, hasCredentials: !!(message.data && message.data.credentials) });
    
    if (!message.data || !message.data.credentials) {
      console.warn('Service worker: Login request missing credentials');
      sendResponse({ error: 'credentials missing' });
      updateConnectionState(false);
      broadcastSessionChange(false);
      initDisconnected().catch((e) => console.warn('initDisconnected failed:', e));
      return;
    }

    // Forward to popup/options page (for non-popup sources)
    console.log('Service worker: Forwarding login request to popup/options page');
    try {
      const response = await sendMessageToPopupOrOptions({
        name: 'myjd-toolbar',
        action: 'login',
        data: message.data,
        _fromServiceWorker: true
      });

      console.log('Service worker: Received login response', response);

      if (response && response.data === true) {
        updateConnectionState(true);
        broadcastSessionChange(true);
        
        // Initialize settings and connected state
        try {
          await initSettings();
          await initConnected();
          await injectContentScripts();
          console.log('Service worker: Initialization after login completed');
        } catch (initError) {
          console.warn('Initialization after login failed:', initError);
          // Don't fail login if initialization fails
        }
        
        sendResponse({ data: true });
      } else {
        updateConnectionState(false);
        broadcastSessionChange(false);
        initDisconnected().catch((e) => console.warn('initDisconnected failed:', e));
        sendResponse({ data: false, error: response?.error });
      }
    } catch (error) {
      console.error('Service worker: Login failed with error:', error);
      updateConnectionState(false);
      broadcastSessionChange(false);
      initDisconnected().catch((e) => console.warn('initDisconnected failed:', e));
      sendResponse({
        data: false,
        error: error.message || 'Failed to connect to popup/options page'
      });
    }
  } catch (error) {
    console.error('Login handler error:', error);
    sendResponse({ data: false, error: error.message });
  }
}

// Handle session info request
async function handleSessionInfo(message, sender, sendResponse) {
  try {
    // First check storage
    const isLoggedIn = await getSessionStateFromStorage();

    // Optionally query popup/options page for more accurate state
    try {
      const response = await sendMessageToPopupOrOptions({
        name: 'myjd-toolbar',
        action: 'session-info',
        _fromServiceWorker: true
      });
      if (response && response.data && typeof response.data.isLoggedIn === 'boolean') {
        sendResponse({ data: { isLoggedIn: response.data.isLoggedIn } });
        return;
      }
    } catch (e) {
      // Fall back to storage value
    }

    sendResponse({ data: { isLoggedIn } });
  } catch (error) {
    console.error('Session info handler error:', error);
    sendResponse({ data: { isLoggedIn: false } });
  }
}

// Initialize disconnected state (remove context menus, clear state)
async function initDisconnected() {
  try {
    // Remove all context menu items
    await chrome.contextMenus.removeAll();
    
    // Update badge
    updateBadge();
  } catch (error) {
    console.warn('Failed to initialize disconnected state:', error);
  }
}

// Handle logout request
async function handleLogout(message, sender, sendResponse) {
  try {
    // Forward to popup/options page
    try {
      const response = await sendMessageToPopupOrOptions({
        name: 'myjd-toolbar',
        action: 'logout',
        _fromServiceWorker: true
      });

      // Clear storage and initialize disconnected state
      chrome.storage.local.clear(() => {
        updateConnectionState(false);
        broadcastSessionChange(false);
        initDisconnected().catch((e) => console.warn('initDisconnected failed:', e));
        sendResponse({ data: response?.data !== false });
      });
    } catch (error) {
      console.warn('Logout failed:', error);
      // Still clear storage even if popup/options page is not available
      chrome.storage.local.clear(() => {
        updateConnectionState(false);
        broadcastSessionChange(false);
        initDisconnected().catch((e) => console.warn('initDisconnected failed:', e));
        sendResponse({ data: true });
      });
    }
  } catch (error) {
    console.error('Logout handler error:', error);
    sendResponse({ data: false, error: error.message });
  }
}

// Handle devices pull request
async function handleDevicesPull(message, sender, sendResponse) {
  try {
    // Forward to popup/options page
    try {
      const response = await sendMessageToPopupOrOptions({
        name: 'myjd-toolbar',
        action: 'devices-pull',
        _fromServiceWorker: true
      });

      if (response && response.data) {
        // Broadcast devices change
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach((tab) => {
            try {
              chrome.tabs.sendMessage(tab.id, {
                name: 'myjd-toolbar',
                action: 'devices-change',
                data: response.data
              });
            } catch (e) {
              // Ignore errors
            }
          });
        });

        chrome.runtime.sendMessage({
          name: 'myjd-toolbar',
          action: 'devices-change',
          data: response.data
        });

        sendResponse({ data: response.data });
      } else {
        sendResponse({ error: response?.error || 'Failed to get devices' });
      }
    } catch (error) {
      console.warn('Devices pull failed:', error);
      sendResponse({
        error: error.message || 'Failed to connect to popup/options page'
      });
    }
  } catch (error) {
    console.error('Devices pull handler error:', error);
    sendResponse({ error: error.message });
  }
}

function handleToolbarMessage(message, sender, sendResponse) {
  const action = message.action;
  const data = message.data || {};

  switch (action) {
    case 'login':
      // Popup now handles login directly, but we still need to handle messages from other sources
      // For popup-initiated logins, they will notify us via login-success
      handleLogin(message, sender, sendResponse);
      return true; // Keep channel open for async response
    case 'login-success':
      // Popup successfully logged in - initialize context menus
      handleLoginSuccess(message, sender, sendResponse);
      return false;
    case 'login-failed':
      // Popup login failed - ensure we're in disconnected state
      handleLoginFailed(message, sender, sendResponse);
      return false;
    case 'session-info':
      handleSessionInfo(message, sender, sendResponse);
      return true; // Keep channel open for async response
    case 'logout':
      handleLogout(message, sender, sendResponse);
      return true; // Keep channel open for async response
    case 'devices-pull':
      handleDevicesPull(message, sender, sendResponse);
      return true; // Keep channel open for async response
    case 'link-info':
      sendResponse({ data: getQueueForTab(data) });
      return false;
    case 'remove-all-requests':
      clearRequestQueue(data.tabId ?? sender.tab?.id);
      sendResponse({});
      return false;
    case 'remove-request':
      removeRequestFromQueue(data.tabId ?? sender.tab?.id, data.requestId);
      sendResponse({});
      return false;
    case 'tab-contentscript-injected':
      if (sender.tab && sender.tab.id !== undefined) {
        delete REQUEST_QUEUE[sender.tab.id];
      }
      sendResponse({});
      return false;
    case 'close-in-page-toolbar':
      closeInPageToolbar(data.tabId ?? sender.tab?.id);
      sendResponse({});
      return false;
    default:
      sendResponse({});
      return false;
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

