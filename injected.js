// injected.js - Script chạy trong page context
(function() {
  console.log('[THG Interceptor] Starting injection...');
  
  const originalFetch = window.fetch;
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  // Store intercepted responses
  window.__interceptedResponses__ = new Map();
  
  // Hook fetch
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, arguments);
    const clonedResponse = response.clone();
    
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      const method = args[1]?.method || 'GET';
      
      if (method.toUpperCase() === 'POST') {
        const data = await clonedResponse.text();
        
        const responseData = {
          url: url,
          method: method,
          data: data,
          timestamp: Date.now()
        };
        
        // Store in map
        const key = Date.now().toString();
        window.__interceptedResponses__.set(key, responseData);
        
        console.log('[THG Interceptor] POST intercepted:', {
          url,
          dataLength: data.length
        });
        
        // Dispatch to DOM for content script
        document.dispatchEvent(new CustomEvent('__thg_response__', {
          detail: responseData
        }));
      }
    } catch(e) {
      console.error('[THG Interceptor] Fetch error:', e);
    }
    
    return response;
  };
  
  // Hook XHR
  XMLHttpRequest.prototype.open = function(method, url) {
    this._method = method;
    this._url = url;
    return originalXHROpen.apply(this, arguments);
  };
  
  XMLHttpRequest.prototype.send = function(body) {
    if (this._method && this._method.toUpperCase() === 'POST') {
      this.addEventListener('load', function() {
        const responseData = {
          url: this._url,
          method: this._method,
          data: this.responseText,
          timestamp: Date.now()
        };
        
        const key = Date.now().toString();
        window.__interceptedResponses__.set(key, responseData);
        
        console.log('[THG Interceptor] XHR POST intercepted:', {
          url: this._url,
          dataLength: this.responseText.length
        });
        
        // Dispatch to DOM
        document.dispatchEvent(new CustomEvent('__thg_response__', {
          detail: responseData
        }));
      });
    }
    return originalXHRSend.apply(this, arguments);
  };
  
  // Signal ready
  document.dispatchEvent(new CustomEvent('__thg_interceptor_ready__'));
})();