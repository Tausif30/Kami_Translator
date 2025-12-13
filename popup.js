// Language name mapping
const LANGUAGE_NAMES = {
  'en': 'English',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh-Hans': 'Chinese (Simplified)',
  'bn': 'Bangla',
  'hi': 'Hindi',
  'ar': 'Arabic',
  'es': 'Spanish',
  'fr': 'French'
};

let currentTab = null;

// Firefox/Chrome compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Get current tab
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];
    
    console.log('Current tab:', currentTab);
    
    if (!currentTab) {
      showStatus('Unable to access current tab', 'error');
      return;
    }
  
    // Load saved target language
    browserAPI.storage.local.get(['targetLanguage'], (result) => {
      if (result.targetLanguage) {
        document.getElementById('targetLang').value = result.targetLanguage;
      }
    });
    
    // Detect page language
    detectPageLanguage();
    
    // Check if page is already translated
    browserAPI.tabs.sendMessage(currentTab.id, { action: 'getTranslationState' }, (response) => {
      if (response && response.isTranslated) {
        document.getElementById('restoreBtn').classList.add('show');
        showStatus('Page is currently translated', 'info');
      }
    });
  } catch (error) {
    console.error('Popup initialization error:', error);
    showStatus('Failed to initialize: ' + error.message, 'error');
  }
});

// Detect page language
async function detectPageLanguage() {
  const originalLangEl = document.getElementById('originalLang');
  
  if (!currentTab) {
    originalLangEl.textContent = 'Tab not available';
    return;
  }
  
  try {
    // Get sample text from page
    browserAPI.tabs.sendMessage(currentTab.id, { action: 'getSampleText' }, async (response) => {
      if (!response || !response.text) {
        originalLangEl.textContent = 'Unable to detect';
        return;
      }
      
      const text = response.text;
      
      if (text.length < 10) {
        originalLangEl.textContent = 'Not enough text';
        return;
      }
      
      // Detect language
      const langCode = await detectLanguage(text);
      originalLangEl.textContent = LANGUAGE_NAMES[langCode] || langCode.toUpperCase();
    });
  } catch (error) {
    originalLangEl.textContent = 'Detection failed';
    console.error('Language detection error:', error);
  }
}

// Translate button
document.getElementById('translateBtn').addEventListener('click', async () => {
  if (!currentTab) {
    showStatus('✗ No active tab found', 'error');
    return;
  }
  
  const targetLang = document.getElementById('targetLang').value;
  const translateBtn = document.getElementById('translateBtn');
  const restoreBtn = document.getElementById('restoreBtn');
  
  translateBtn.disabled = true;
  translateBtn.textContent = 'Translating...';
  showStatus('Extracting page text...', 'info');
  
  try {
    // Get all text nodes from page
    browserAPI.tabs.sendMessage(currentTab.id, { action: 'extractTexts' }, async (response) => {
      if (!response || !response.texts || response.texts.length === 0) {
        throw new Error('No text found on page');
      }
      
      showStatus(`Translating ${response.texts.length} text elements...`, 'info');
      
      // Translate texts in batches
      const batchSize = 100; // Azure allows up to 100 texts per request
      const translations = [];
      
      for (let i = 0; i < response.texts.length; i += batchSize) {
        const batch = response.texts.slice(i, i + batchSize);
        showStatus(`Translating batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(response.texts.length / batchSize)}...`, 'info');
        
        const batchTranslations = await translateBatch(batch, targetLang);
        translations.push(...batchTranslations);
      }
      
      // Send translations back to page
      showStatus('Applying translations...', 'info');
      browserAPI.tabs.sendMessage(currentTab.id, {
        action: 'applyTranslations',
        translations: translations,
        targetLanguage: targetLang,
        tabId: currentTab.id
      }, (applyResponse) => {
        if (applyResponse && applyResponse.success) {
          showStatus(`✓ Page translated successfully!`, 'success');
          restoreBtn.classList.add('show');
        } else {
          throw new Error('Failed to apply translations');
        }
      });
      
    });
  } catch (error) {
    showStatus(`✗ ${error.message}`, 'error');
    console.error('Translation error:', error);
  } finally {
    translateBtn.disabled = false;
    translateBtn.textContent = 'Translate Page';
  }
});

// Restore button
document.getElementById('restoreBtn').addEventListener('click', () => {
  if (!currentTab) {
    showStatus('✗ No active tab found', 'error');
    return;
  }
  
  browserAPI.tabs.sendMessage(currentTab.id, { action: 'restoreOriginal' }, (response) => {
    if (response && response.success) {
      showStatus('✓ Original text restored', 'success');
      document.getElementById('restoreBtn').classList.remove('show');
    }
  });
});

// Save target language when changed
document.getElementById('targetLang').addEventListener('change', (e) => {
  browserAPI.storage.local.set({ targetLanguage: e.target.value });
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
    body: JSON.stringify([{ text: text.substring(0, 1000) }]) // Limit to 1000 chars for detection
  });
  
  if (!response.ok) {
    throw new Error(`Detection failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  if (data && data[0] && data[0].language) {
    return data[0].language;
  }
  
  throw new Error('Unexpected response format');
}

// Translate batch function
async function translateBatch(texts, targetLang) {
  const endpoint = CONFIG.AZURE_ENDPOINT;
  const path = '/translate';
  const apiVersion = '3.0';
  
  const url = `${endpoint}${path}?api-version=${apiVersion}&to=${targetLang}`;
  
  // Prepare request body
  const requestBody = texts.map(text => ({ text }));
  
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
  
  // Extract translated texts
  return data.map(item => item.translations[0].text);
}

// Show status message
function showStatus(message, type) {
  const statusEl = document.getElementById('statusMessage');
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;
}