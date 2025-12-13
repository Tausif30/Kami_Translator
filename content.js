// Store original texts for restoration
let originalTexts = [];
let textNodes = [];
let isTranslated = false;
let targetLanguage = null;
let lastScrollY = 0;
let scrollThreshold = 0;
let isAutoTranslating = false;
// Map to store original text by node (so we don't lose originals when re-extracting)
let originalTextMap = new WeakMap();
// Cache for already translated texts
let translationCache = new Map();
// Track already translated nodes to avoid re-translating
let translatedNodes = new WeakSet();
// Debounce timer for scroll events
let scrollDebounceTimer = null;

// Firefox/Chrome compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Get current tab ID
let currentTabId = null;
browserAPI.runtime.sendMessage({ action: 'getTabId' }, (response) => {
  if (response && response.tabId) {
    currentTabId = response.tabId;
    checkAutoTranslate();
  }
});

// Check if auto-translate is enabled for this specific tab
function checkAutoTranslate() {
  browserAPI.storage.local.get(['translationSettings'], (result) => {
    const settings = result.translationSettings || {};
    const tabSettings = settings[currentTabId];
    
    console.log('Auto-translate settings for tab', currentTabId, ':', tabSettings);
    if (tabSettings && tabSettings.enabled && tabSettings.targetLanguage) {
      targetLanguage = tabSettings.targetLanguage;
      console.log('Auto-translate enabled for language:', targetLanguage);
      // Wait a bit for page to load before first translation
      setTimeout(() => {
        console.log('Starting initial translation and scroll monitoring');
        translateVisibleContent();
        enableScrollTranslation();
      }, 1000);
    }
  });
}

// Initialize auto-translation on page load
// Moved to checkAutoTranslate function above

// Listen for messages from popup and background
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getSampleText') {
    const sampleText = getSampleText();
    sendResponse({ text: sampleText });
  }
  
  if (message.action === 'extractTexts') {
    const texts = extractAllTexts();
    sendResponse({ texts });
  }
  
  if (message.action === 'applyTranslations') {
    applyTranslations(message.translations);
    // Store target language for auto-translation on scroll for this specific tab
    if (message.targetLanguage && message.tabId) {
      currentTabId = message.tabId;
      targetLanguage = message.targetLanguage;
      
      browserAPI.storage.local.get(['translationSettings'], (result) => {
        const settings = result.translationSettings || {};
        settings[currentTabId] = {
          enabled: true,
          targetLanguage: targetLanguage
        };
        browserAPI.storage.local.set({ translationSettings: settings });
      });
      
      enableScrollTranslation();
    }
    sendResponse({ success: true });
  }
  
  if (message.action === 'restoreOriginal') {
    restoreOriginalTexts();
    disableScrollTranslation();
    sendResponse({ success: true });
  }
  
  if (message.action === 'getTranslationState') {
    sendResponse({ isTranslated });
  }
  
  if (message.action === 'showTranslation') {
    showTranslationTooltip(message);
  }
  
  return true; // Keep message channel open for async response
});

// Show translation tooltip for selected text
function showTranslationTooltip(data) {
  // Remove existing tooltip if any
  const existingTooltip = document.getElementById('azure-translator-tooltip');
  if (existingTooltip) {
    existingTooltip.remove();
  }
  
  // Create tooltip
  const tooltip = document.createElement('div');
  tooltip.id = 'azure-translator-tooltip';
  tooltip.className = 'azure-translator-tooltip';
  
  if (data.error) {
    tooltip.innerHTML = `
      <div class="tooltip-header">Translation Error</div>
      <div class="tooltip-content error">${escapeHtml(data.error)}</div>
      <button class="tooltip-close">×</button>
    `;
  } else {
    const langNames = {
      'en': 'English', 'ja': 'Japanese', 'ko': 'Korean',
      'zh-Hans': 'Chinese', 'bn': 'Bangla', 'hi': 'Hindi',
      'ar': 'Arabic', 'es': 'Spanish', 'fr': 'French'
    };
    
    const sourceName = langNames[data.sourceLang] || data.sourceLang.toUpperCase();
    const targetName = langNames[data.targetLang] || data.targetLang.toUpperCase();
    
    tooltip.innerHTML = `
      <div class="tooltip-header">Translation (${sourceName} → ${targetName})</div>
      <div class="tooltip-content">
        <div class="original"><strong>Original:</strong> ${escapeHtml(data.original)}</div>
        <div class="translation"><strong>Translation:</strong> ${escapeHtml(data.translation)}</div>
      </div>
      <button class="tooltip-close">×</button>
    `;
  }
  
  // Position tooltip near selection
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    tooltip.style.left = `${rect.left + window.scrollX}px`;
    tooltip.style.top = `${rect.bottom + window.scrollY + 10}px`;
  }
  
  document.body.appendChild(tooltip);
  
  // Close button handler
  tooltip.querySelector('.tooltip-close').addEventListener('click', () => {
    tooltip.remove();
  });
  
  // Auto-remove after 10 seconds
  setTimeout(() => {
    if (tooltip.parentNode) {
      tooltip.remove();
    }
  }, 10000);
  
  // Remove on click outside
  document.addEventListener('click', function removeTooltip(e) {
    if (!tooltip.contains(e.target)) {
      tooltip.remove();
      document.removeEventListener('click', removeTooltip);
    }
  });
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Get sample text for language detection
function getSampleText() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        // Skip script, style, and hidden elements
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        const tagName = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'iframe'].includes(tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Skip if parent is hidden
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Only accept nodes with meaningful text
        const text = node.textContent.trim();
        if (text.length > 0) {
          return NodeFilter.FILTER_ACCEPT;
        }
        
        return NodeFilter.FILTER_REJECT;
      }
    }
  );
  
  let sampleText = '';
  let node;
  
  // Collect first 500 characters of text
  while (node = walker.nextNode()) {
    sampleText += node.textContent + ' ';
    if (sampleText.length > 500) break;
  }
  
  return sampleText.trim();
}

// Check if element is visible in viewport
function isElementInViewport(element) {
  const rect = element.getBoundingClientRect();
  return (
    rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
    rect.bottom > 0 &&
    rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
    rect.right > 0
  );
}

// Extract all text nodes from page
function extractAllTexts() {
  // Clear and rebuild textNodes array each time
  textNodes = [];
  // Only store originals if this is the first translation (before any translation has been applied)
  const shouldStoreOriginals = originalTexts.length === 0;
  if (shouldStoreOriginals) {
    originalTexts = [];
  }
  const texts = [];
  
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        const tagName = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'iframe', 'code', 'pre'].includes(tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Skip if parent is hidden
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        
        const text = node.textContent.trim();
        if (text.length > 0) {
          return NodeFilter.FILTER_ACCEPT;
        }
        
        return NodeFilter.FILTER_REJECT;
      }
    }
  );
  
  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (text.length > 0) {
      // Only include text if its parent element is in viewport
      const parent = node.parentElement;
      if (parent && isElementInViewport(parent)) {
        // Skip nodes that have already been translated
        if (!translatedNodes.has(node)) {
          textNodes.push(node);
          // Store original text in WeakMap if not already stored
          if (!originalTextMap.has(node)) {
            originalTextMap.set(node, node.textContent);
          }
          // Only store original text the first time for the array
          if (shouldStoreOriginals) {
            originalTexts.push(originalTextMap.get(node));
          }
          texts.push(text);
        }
      }
    }
  }
  
  return texts;
}

// Apply translations to page
function applyTranslations(translations) {
  if (translations.length !== textNodes.length) {
    console.error('Translation count mismatch');
    return;
  }
  
  // Apply each translation
  for (let i = 0; i < textNodes.length; i++) {
    const node = textNodes[i];
    const translation = translations[i];
    
    // Preserve leading/trailing whitespace from original
    const original = node.textContent;
    const leadingSpace = original.match(/^\s*/)[0];
    const trailingSpace = original.match(/\s*$/)[0];
    
    node.textContent = leadingSpace + translation + trailingSpace;
    
    // Mark this node as translated to avoid re-translating
    translatedNodes.add(node);
  }
  
  isTranslated = true;
}

// Restore original texts
function restoreOriginalTexts() {
  // Restore all nodes that were translated using the WeakMap
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );
  
  let node;
  while (node = walker.nextNode()) {
    if (originalTextMap.has(node)) {
      node.textContent = originalTextMap.get(node);
    }
  }
  
  isTranslated = false;
  // Clear stored data so next translation starts fresh with the original content
  originalTexts = [];
  textNodes = [];
  originalTextMap = new WeakMap();
  translatedNodes = new WeakSet();
  translationCache.clear();
}

// Enable scroll-based auto-translation
function enableScrollTranslation() {
  lastScrollY = window.scrollY;
  scrollThreshold = window.innerHeight * 0.3; // 30% of viewport height
  window.addEventListener('scroll', handleScroll);
}

// Disable scroll-based auto-translation
function disableScrollTranslation() {
  window.removeEventListener('scroll', handleScroll);
  targetLanguage = null;
  
  // Remove this tab from enabled tabs
  if (currentTabId) {
    browserAPI.storage.local.get(['translationSettings'], (result) => {
      const settings = result.translationSettings || {};
      delete settings[currentTabId];
      browserAPI.storage.local.set({ translationSettings: settings });
    });
  }
}

// Handle scroll events with debouncing
function handleScroll() {
  if (!targetLanguage || isAutoTranslating) {
    return;
  }
  
  // Clear existing debounce timer
  if (scrollDebounceTimer) {
    clearTimeout(scrollDebounceTimer);
  }
  
  // Debounce scroll events by 500ms
  scrollDebounceTimer = setTimeout(() => {
    const currentScrollY = window.scrollY;
    const scrollDelta = Math.abs(currentScrollY - lastScrollY);
    
    // Check if scrolled more than threshold
    if (scrollDelta >= scrollThreshold) {
      console.log('Threshold reached, triggering translation');
      lastScrollY = currentScrollY;
      translateVisibleContent();
    }
  }, 500);
}

// Automatically translate newly visible content
async function translateVisibleContent() {
  if (isAutoTranslating) return;
  
  console.log('translateVisibleContent called');
  isAutoTranslating = true;
  
  try {
    // Extract currently visible texts (this will update textNodes)
    const texts = extractAllTexts();
    
    console.log('Extracted texts:', texts.length);
    
    if (texts.length === 0) {
      console.log('No texts found, skipping translation');
      isAutoTranslating = false;
      return;
    }
    
    console.log('Sending translation request to background script');
    
    // Request translation from background script
    browserAPI.runtime.sendMessage({
      action: 'translateTexts',
      texts: texts,
      targetLang: targetLanguage
    }, (response) => {
      console.log('Translation response received:', response);
      if (browserAPI.runtime.lastError) {
        console.error('Runtime error:', browserAPI.runtime.lastError);
        isAutoTranslating = false;
        return;
      }
      
      if (response && response.translations) {
        console.log('Applying translations:', response.translations.length);
        // Apply translations to the newly extracted textNodes
        applyTranslations(response.translations);
      } else if (response && response.error) {
        console.error('Translation error:', response.error);
      }
      isAutoTranslating = false;
    });
  } catch (error) {
    console.error('Auto-translation error:', error);
    isAutoTranslating = false;
  }
}