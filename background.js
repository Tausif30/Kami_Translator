// Import config
importScripts('config.js');

// Firefox/Chrome compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

console.log('Background script loaded');
console.log('browserAPI:', browserAPI ? 'available' : 'NOT available');

// Create context menu on install
browserAPI.runtime.onInstalled.addListener(() => {
  console.log('Extension installed/updated');
  browserAPI.contextMenus.create({
    id: 'translatePage',
    title: 'Translate this page',
    contexts: ['page']
  });
  
  browserAPI.contextMenus.create({
    id: 'translateSelection',
    title: 'Translate "%s"',
    contexts: ['selection']
  });
});

// Handle messages from content script
console.log('Setting up message listener');
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message.action, 'from tab:', sender.tab?.id);
  
  if (message.action === 'getTabId') {
    sendResponse({ tabId: sender.tab?.id });
    return true;
  }
  
  if (message.action === 'translateTexts') {
    console.log('Translating texts:', message.texts.length, 'to', message.targetLang);
    translateBatch(message.texts, message.targetLang)
      .then(translations => {
        console.log('Translation successful:', translations.length);
        sendResponse({ translations });
      })
      .catch(error => {
        console.error('Translation error:', error);
        sendResponse({ error: error.message });
      });
    return true; // Keep channel open for async response
  }
});

// Translate batch function
async function translateBatch(texts, targetLang) {
  const endpoint = CONFIG.AZURE_ENDPOINT;
  const path = '/translate';
  const apiVersion = '3.0';
  
  const url = `${endpoint}${path}?api-version=${apiVersion}&to=${targetLang}`;
  
  // Prepare request body - handle batches up to 100 items
  const batchSize = 100;
  const allTranslations = [];
  
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const requestBody = batch.map(text => ({ text }));
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': CONFIG.AZURE_SUBSCRIPTION_KEY,
        'Ocp-Apim-Subscription-Region': CONFIG.AZURE_REGION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Translation failed: ${response.status}`);
    }
    
    const data = await response.json();
    const translations = data.map(item => item.translations[0].text);
    allTranslations.push(...translations);
  }
  
  return allTranslations;
}

// Handle context menu clicks
browserAPI.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'translatePage') {
    // Open popup when right-clicking on page
    if (browserAPI.browserAction) {
      browserAPI.browserAction.openPopup();
    } else if (browserAPI.action) {
      browserAPI.action.openPopup();
    }
  }
  
  if (info.menuItemId === 'translateSelection') {
    const selectedText = info.selectionText;
    
    try {
      // Detect the language
      const detectedLang = await detectLanguage(selectedText);
      
      // Default translation target is English, unless source is English
      let targetLang = 'en';
      if (detectedLang === 'en') {
        targetLang = 'ja'; // Translate to Japanese if source is English
      }
      
      // Translate the text
      const translation = await translateText(selectedText, targetLang);
      
      // Send translation to content script
      browserAPI.tabs.sendMessage(tab.id, {
        action: 'showTranslation',
        original: selectedText,
        translation: translation,
        sourceLang: detectedLang,
        targetLang: targetLang
      });
    } catch (error) {
      browserAPI.tabs.sendMessage(tab.id, {
        action: 'showTranslation',
        error: error.message
      });
    }
  }
});

// Detect language function
async function detectLanguage(text) {
  const endpoint = CONFIG.AZURE_ENDPOINT;
  const path = '/detect';
  const apiVersion = '3.0';
  
  const url = `${endpoint}${path}?api-version=${apiVersion}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': CONFIG.AZURE_SUBSCRIPTION_KEY,
      'Ocp-Apim-Subscription-Region': CONFIG.AZURE_REGION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([{ text }])
  });
  
  if (!response.ok) {
    throw new Error(`Detection failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  if (data && data[0] && data[0].language) {
    return data[0].language;
  }
  
  throw new Error('Unable to detect language');
}

// Translation function
async function translateText(text, targetLang) {
  const endpoint = CONFIG.AZURE_ENDPOINT;
  const path = '/translate';
  const apiVersion = '3.0';
  
  const url = `${endpoint}${path}?api-version=${apiVersion}&to=${targetLang}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': CONFIG.AZURE_SUBSCRIPTION_KEY,
      'Ocp-Apim-Subscription-Region': CONFIG.AZURE_REGION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([{ text }])
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Translation failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  if (data && data[0] && data[0].translations && data[0].translations[0]) {
    return data[0].translations[0].text;
  }
  
  throw new Error('Unexpected response format');
}