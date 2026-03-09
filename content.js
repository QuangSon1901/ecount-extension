const API_URL='https://express.thgfulfill.com';

// POD factory carrier mapping: Location code → Carrier name
const POD_CARRIER_MAP = {
    '001': 'Printposs',
    '002': 'ONOS',
    '004': 'S2BDIY'
};

class LoadingOverlay {
    constructor() {
        this.overlay = null;
        this.progressBar = null;
        this.textElement = null;
        this.subtextElement = null;
        this.progressElement = null;
        this.batchListElement = null;
    }

    show(text = 'Đang xử lý...', subtext = '') {
        // Remove existing overlay
        this.hide();

        // Create overlay
        this.overlay = document.createElement('div');
        this.overlay.className = 'yun-loading-overlay';
        
        this.overlay.innerHTML = `
            <div class="yun-loading-content">
                <div class="yun-loading-spinner"></div>
                <div class="yun-loading-text">${text}</div>
                <div class="yun-loading-subtext">${subtext}</div>
                <div class="yun-loading-progress-bar">
                    <div class="yun-loading-progress-fill" style="width: 0%"></div>
                </div>
                <div class="yun-loading-progress">0 / 0</div>
                <div class="yun-loading-batch-list"></div>
            </div>
        `;

        document.body.appendChild(this.overlay);

        // Store references
        this.textElement = this.overlay.querySelector('.yun-loading-text');
        this.subtextElement = this.overlay.querySelector('.yun-loading-subtext');
        this.progressElement = this.overlay.querySelector('.yun-loading-progress');
        this.progressBar = this.overlay.querySelector('.yun-loading-progress-fill');
        this.batchListElement = this.overlay.querySelector('.yun-loading-batch-list');

        // Prevent background clicks
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                e.stopPropagation();
            }
        });

        console.log('[THG Extension] Loading overlay shown');
    }

    updateText(text) {
        if (this.textElement) {
            this.textElement.textContent = text;
        }
    }

    updateSubtext(subtext) {
        if (this.subtextElement) {
            this.subtextElement.textContent = subtext;
        }
    }

    updateProgress(current, total) {
        if (this.progressElement) {
            this.progressElement.textContent = `${current} / ${total}`;
        }
        
        if (this.progressBar) {
            const percentage = total > 0 ? (current / total * 100) : 0;
            this.progressBar.style.width = `${percentage}%`;
        }
    }

    hide() {
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
            console.log('[THG Extension] Loading overlay hidden');
        }
    }
}

// Global instance
const loadingOverlay = new LoadingOverlay();

// ============================================
// PART 1: INJECT INTERCEPTOR (FIXED)
// ============================================

(function initInterceptor() {
    // Inject script file vào page
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = function () {
        console.log('[THG Extension] Injected script loaded');
        this.remove();
    };
    (document.head || document.documentElement).appendChild(script);

    console.log('[THG Extension] Injecting interceptor script...');
})();

// ============================================
// PART 2: RESPONSE HANDLER (UPDATED)
// ============================================

let pendingResponseResolvers = new Map(); // Đổi từ array sang Map
let interceptorReady = false;

// Wait for interceptor ready
document.addEventListener('__thg_interceptor_ready__', () => {
    interceptorReady = true;
    console.log('[THG Extension] ✅ Interceptor is ready');
});

document.addEventListener('__thg_response__', (event) => {
    const { url, method, data } = event.detail;
    
    try {
        // Parse response để lấy erpOrderCode
        let parsedData = data;
        
        // Decode base64 nếu cần
        try {
            parsedData = atob(data);
        } catch (e) {
            // Not base64
        }

        // Parse JSON để lấy erpOrderCode
        const orderInfo = parseEcountData(parsedData);
        
        if (!orderInfo || !orderInfo.erpOrderCode) {
            console.warn('[THG Extension] Cannot extract erpOrderCode from response');
            return;
        }

        const erpOrderCode = orderInfo.erpOrderCode;
        console.log('[THG Extension] Response received for Code-THG:', erpOrderCode);

        // ✅ Tìm resolver theo erpOrderCode (Code-THG)
        const resolver = pendingResponseResolvers.get(erpOrderCode);
        
        if (resolver) {
            try {
                console.log('[THG Extension] ✅ Matched resolver for:', erpOrderCode);
                resolver.resolve(data);
                pendingResponseResolvers.delete(erpOrderCode);
            } catch (e) {
                console.error('[THG Extension] Error resolving:', e);
                resolver.reject(e);
                pendingResponseResolvers.delete(erpOrderCode);
            }
        } else {
            console.warn('[THG Extension] ⚠️ No pending resolver for Code-THG:', erpOrderCode);
            console.warn('[THG Extension] Pending resolvers:', Array.from(pendingResponseResolvers.keys()));
        }
        
    } catch (error) {
        console.error('[THG Extension] Error handling response:', error);
    }
});

// Helper function để extract request ID
function extractRequestIdFromResponse(url, data) {
    // ✅ Option 1: Tìm requestId từ URL response
    // ECount thường trả URL có dạng: ...?sid=xxx hoặc ...&sid=xxx
    const sidMatch = url.match(/[?&]sid[_=]([^&]+)/i);
    
    if (sidMatch) {
        const sid = sidMatch[1];
        
        // Tìm requestId match với selector chứa sid này
        for (const [reqId, resolver] of pendingResponseResolvers.entries()) {
            if (resolver.selector && resolver.selector.includes(sid)) {
                console.log(`[THG Extension] ✅ Matched by SID: ${sid} → ${reqId}`);
                return reqId;
            }
        }
    }
    
    // ✅ Option 2: Từ clicked element (fallback)
    // CHỈ lấy element CÓ attribute data-request-id
    const clickedElements = document.querySelectorAll('[data-request-id]');
    
    if (clickedElements.length === 1) {
        // Chỉ có 1 element đang chờ → an toàn
        const reqId = clickedElements[0].getAttribute('data-request-id');
        clickedElements[0].removeAttribute('data-request-id');
        console.log(`[THG Extension] ✅ Matched by single element: ${reqId}`);
        return reqId;
    } else if (clickedElements.length > 1) {
        // ⚠️ Nhiều elements chờ → match bằng timestamp (FIFO)
        console.warn(`[THG Extension] ⚠️ Multiple pending elements: ${clickedElements.length}`);
        
        // Lấy request cũ nhất (FIFO)
        let oldestReqId = null;
        let oldestTimestamp = Infinity;
        
        for (const [reqId, resolver] of pendingResponseResolvers.entries()) {
            if (resolver.timestamp < oldestTimestamp) {
                oldestTimestamp = resolver.timestamp;
                oldestReqId = reqId;
            }
        }
        
        if (oldestReqId) {
            // Tìm và cleanup element tương ứng
            for (const el of clickedElements) {
                if (el.getAttribute('data-request-id') === oldestReqId) {
                    el.removeAttribute('data-request-id');
                    break;
                }
            }
            console.log(`[THG Extension] ✅ Matched by FIFO: ${oldestReqId}`);
            return oldestReqId;
        }
    }
    
    // ✅ Option 3: Fallback - lấy oldest pending request
    if (pendingResponseResolvers.size > 0) {
        let oldestReqId = null;
        let oldestTimestamp = Infinity;
        
        for (const [reqId, resolver] of pendingResponseResolvers.entries()) {
            if (resolver.timestamp < oldestTimestamp) {
                oldestTimestamp = resolver.timestamp;
                oldestReqId = reqId;
            }
        }
        
        console.log(`[THG Extension] ⚠️ Fallback to oldest pending: ${oldestReqId}`);
        return oldestReqId;
    }
    
    console.error('[THG Extension] ❌ Cannot extract requestId from:', url);
    return null;
}

// ============================================
// PART 3: GET RESPONSE FUNCTION (UPDATED)
// ============================================

function getXExtendResponse(selector, codeThg) {
    return new Promise((resolve, reject) => {
        if (!interceptorReady) {
            reject(new Error('Interceptor chưa sẵn sàng'));
            return;
        }

        if (!codeThg) {
            reject(new Error('Code-THG không hợp lệ'));
            return;
        }

        let timeoutId;

        const cleanup = () => {
            clearTimeout(timeoutId);
            pendingResponseResolvers.delete(codeThg);
        };

        // ✅ Check xem Code-THG này đã có resolver chưa (tránh duplicate)
        if (pendingResponseResolvers.has(codeThg)) {
            console.warn(`[THG Extension] ⚠️ Code-THG "${codeThg}" already has a pending request, skipping...`);
            reject(new Error(`Đơn hàng ${codeThg} đang được xử lý`));
            return;
        }

        // Add to pending Map với Code-THG làm key
        pendingResponseResolvers.set(codeThg, {
            selector,
            codeThg,
            timestamp: Date.now(),
            resolve: (data) => {
                try {
                    let decodedData = data;

                    // Try decode base64
                    try {
                        decodedData = atob(data);
                        console.log('[THG Extension] Base64 decoded for', codeThg);
                    } catch (e) {
                        // Not base64, use as is
                    }

                    cleanup();
                    resolve(decodedData);
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            },
            reject: (error) => {
                cleanup();
                reject(error);
            }
        });

        console.log(`[THG Extension] [${codeThg}] Added to pending Map, total:`, pendingResponseResolvers.size);

        // Click element after small delay
        setTimeout(() => {
            const el = document.querySelector('a#' + CSS.escape(selector));
            if (!el) {
                console.error(`[THG Extension] [${codeThg}] Element not found:`, selector);
                cleanup();
                reject(new Error('Không tìm thấy element: ' + selector));
                return;
            }

            console.log(`[THG Extension] [${codeThg}] Clicking element:`, selector);
            
            el.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            }));
        }, 100);

        // Timeout 30s
        timeoutId = setTimeout(() => {
            console.error(`[THG Extension] [${codeThg}] ⏱️ Timeout for selector:`, selector);
            cleanup();
            reject(new Error(`Timeout: Không nhận được response sau 30 giây (${codeThg})`));
        }, 10000);
    });
}

// ============================================
// PART 4: PARSE ECOUNT DATA (UPDATED)
// ============================================

function parseEcountData(jsonData) {
    try {
        let data = jsonData;

        // Nếu là string thì parse
        if (typeof jsonData === 'string') {
            const startPattern = '$.xextend(';
            const startIndex = jsonData.indexOf(startPattern);

            if (startIndex !== -1) {
                let bracketCount = 0;
                let jsonStart = startIndex + startPattern.length;
                let jsonEnd = jsonStart;

                for (let i = jsonStart; i < jsonData.length; i++) {
                    if (jsonData[i] === '{') bracketCount++;
                    if (jsonData[i] === '}') bracketCount--;

                    if (bracketCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }

                const jsonString = jsonData.substring(jsonStart, jsonEnd);
                data = JSON.parse(jsonString);
            }
        }

        // Kiểm tra structure
        if (!data || !data.InitDatas || !data.InitDatas.ViewData) {
            return null;
        }

        const masterData = data.InitDatas.ViewData.Master;
        const detailsString = data.InitDatas.ViewData.Details;
        const defaultOption = data.DefaultOption;

        // Parse Details nếu là string
        const detailsData = typeof detailsString === 'string'
            ? JSON.parse(detailsString)
            : detailsString;

        // Detect POD order by WH_CD (Location code)
        const whCode = masterData?.WH_CD || '';
        if (POD_CARRIER_MAP.hasOwnProperty(whCode)) {
            return parseEcountDataPOD(masterData, detailsData, defaultOption);
        }

        const result = {
            _orderType: 'express',
            // API format fields
            carrier: "YUNEXPRESS",
            customerOrderNumber: masterData?.P_DES6 || "",
            platformOrderNumber: "",
            trackingNumber: masterData.ADD_TXT?.ADD_TXT_01 || "",
            referenceNumbers: [],
            weightUnit: "KG",
            sizeUnit: "CM",
            productCode: masterData.ADD_LTXT?.ADD_LTXT_02,

            partnerID: masterData.CUST,
            partnerName: fixUTF8Encoding(masterData?.CUST_DES || ""),
            
            receiver: {
                firstName: fixUTF8Encoding(masterData?.P_DES2 || ""), // ✅ Fix encoding
                lastName: "",
                company: "",
                countryCode: masterData.ADD_TXT?.ADD_TXT_05 || "",
                province: fixUTF8Encoding(masterData.ADD_TXT?.ADD_TXT_09 || ""), // ✅
                city: fixUTF8Encoding(masterData.ADD_TXT?.ADD_TXT_08 || ""), // ✅
                addressLines: [
                    fixUTF8Encoding(masterData.ADD_TXT?.ADD_TXT_06 || ""), // ✅
                    fixUTF8Encoding(masterData?.P_DES5 || "") // ✅
                ].filter(line => line.trim() !== ""),
                postalCode: masterData?.P_DES1 || "",
                phoneNumber: masterData.ADD_TXT?.ADD_TXT_03 || "",
                email: masterData.P_DES4 || "",
                certificateType: "",
                certificateCode: ""
            },

            platform: {
                platform_name: masterData.REMARKS_WIN || '' 
            },
            
            packages: [],
            
            declarationInfo: [],
            
            customsNumber: {
                tax_number: "",
                ioss_code: masterData.ADD_LTXT?.ADD_LTXT_03 || "",
                vat_code: masterData.ADD_NUM?.ADD_NUM_01
                    ? parseInt(masterData.ADD_NUM.ADD_NUM_01, 10) || ""
                    : "",
                eori_number: masterData.ADD_TXT?.ADD_TXT_10 || "",
            },
            
            extraServices: [
                {
                    extra_code: masterData.ADD_TXT?.ADD_TXT_07 || ""
                }
            ],
            
            sensitiveType: "",
            labelType: "PDF",
            sourceCode: "",
            erpOrderCode: defaultOption.DocNo || "",
            erpStatus: "Chờ xác nhận",
            ecountLink: window.location.hash
        };

        // Xử lý chi tiết sản phẩm
        let packageWeight = 0;
        let packageLength = 0;
        let packageWidth = 0;
        let packageHeight = 0;

        if (Array.isArray(detailsData)) {
            detailsData.forEach((item, index) => {
                const qty = parseFloat(item.QTY) || 0;
                const unitPrice = parseFloat(item.ADD_NUM?.ADD_NUM_05) || 0;
                const sellingPrice = parseFloat(item.ADD_NUM?.ADD_NUM_02) || 0;
                const unitWeight = parseFloat(item.ADD_NUM?.ADD_NUM_03) || 0;

                packageWeight += parseFloat(item.ADD_NUM?.ADD_NUM_04) || 0;
                if (index==0) {
                    packageLength = parseFloat(item.ADD_TXT?.ADD_TXT_02) || '';
                    packageWidth  = parseFloat(item.ADD_TXT?.ADD_TXT_03) || '';
                    packageHeight = parseFloat(item.ADD_TXT?.ADD_TXT_04) || '';
                }

                result.declarationInfo.push({
                    sku_code: "",
                    name_en: fixUTF8Encoding(item.ADD_TXT?.ADD_TXT_06 || ""), // ✅ Fix encoding
                    name_local: fixUTF8Encoding(item.ADD_TXT?.ADD_TXT_05 || ""), // ✅ Fix encoding - ĐÂY LÀ CHỖ QUAN TRỌNG!
                    quantity: parseInt(qty) || 0,
                    unit_price: unitPrice,
                    selling_price: sellingPrice,
                    unit_weight: unitWeight,
                    hs_code: "",
                    sales_url: "",
                    currency: "USD",
                    material: "",
                    purpose: "",
                    brand: "",
                    spec: "",
                    model: "",
                    remark: ""
                });
            });
        }

        result.packages.push({
            length: packageLength,
            width: packageWidth,
            height: packageHeight,
            weight: packageWeight
        });

        console.log('[THG Extension] Parsed data:', result);
        return result;

    } catch (error) {
        console.error('[THG Extension] Error parsing data:', error);
        return null;
    }
}

// ============================================
// PART 4B: PARSE ECOUNT DATA FOR POD ORDERS
// ============================================

function parseEcountDataPOD(masterData, detailsData, defaultOption) {
    try {
        const whCode = masterData?.WH_CD || '';
        const carrier = POD_CARRIER_MAP[whCode] || 'UNKNOWN';

        const service = masterData.PJT_CD || '';
        let shippingMethod = '';
        switch (service) {
            case 'SBSL':
                shippingMethod = 'EXPRESS_US';
                break;
            default:
                shippingMethod = service;
        }

        const result = {
            _orderType: 'pod',
            carrier: carrier,
            partnerID: masterData.CUST || '',
            partnerName: fixUTF8Encoding(masterData?.CUST_DES || ''),
            customerOrderNumber: masterData?.P_DES6 || '',
            erpOrderCode: defaultOption?.DocNo || '',
            erpStatus: 'Đang xử lý',
            ecountLink: window.location.hash,

            tracking: {
                trackingNumber: masterData.ADD_TXT?.ADD_TXT_10 || '',
                linkPrint: masterData.ADD_TXT?.ADD_TXT_12 || '',
                carrier: service === 'SBTT' ? 'USPS' : ''
            },

            receiver: {
                firstName: fixUTF8Encoding(masterData?.P_DES2 || ''),
                lastName: '',
                countryCode: masterData.ADD_TXT?.ADD_TXT_05 || '',
                province: fixUTF8Encoding(masterData?.P_DES5 || ''),
                city: fixUTF8Encoding(masterData.ADD_TXT?.ADD_TXT_04 || ''),
                addressLines: [
                    fixUTF8Encoding(masterData?.P_DES3 || ''),
                    fixUTF8Encoding(masterData?.P_DES1 || '')
                ].filter(line => line.trim() !== ''),
                postalCode: masterData?.ADD_TXT?.ADD_TXT_01 || '',
                phoneNumber: masterData.ADD_TXT?.ADD_TXT_11 || '',
                email: masterData?.ADD_TXT?.ADD_TXT_02 || ''
            },

            items: [],
            shippingMethod: shippingMethod
        };

        // Parse detail items
        if (Array.isArray(detailsData)) {
            detailsData.forEach(item => {
                // Design URL: ADD_TXT_07 in detail items
                const designUrl = item.ADD_TXT?.ADD_TXT_07 || '';
                // Mockup URL: REMARKS in detail items
                const mockupUrl = item.REMARKS || '';

                result.items.push({
                    sku: item.PROD_CD || '',
                    product_id: 'THG',
                    name: fixUTF8Encoding(item.PROD_DES || ''),
                    quantity: parseInt(item.QTY) || 0,
                    price: parseFloat(item.PRICE) || 0,
                    image: mockupUrl,
                    print_areas: designUrl ? [{ key: 'front', value: designUrl }] : [],
                    design_urls: designUrl ? [{ key: 'front', value: designUrl }] : []
                });
            });
        }

        console.log('[THG Extension] Parsed POD data:', result);
        return result;

    } catch (error) {
        console.error('[THG Extension] Error parsing POD data:', error);
        return null;
    }
}

function fixUTF8Encoding(text) {
    if (!text || typeof text !== 'string') return text;

    try {
        // Nếu text chứa ký tự > U+00FF → đã là Unicode đúng rồi, không cần fix
        // (Latin-1 chỉ tạo ra ký tự trong range U+0000-U+00FF)
        if (/[^\u0000-\u00FF]/.test(text)) {
            return text;
        }

        // Nếu chỉ có ASCII thuần → không cần fix
        if (!/[\u0080-\u00FF]/.test(text)) {
            return text;
        }

        // Thử interpret các ký tự như raw bytes và decode UTF-8
        const bytes = new Uint8Array(
            text.split('').map(char => char.charCodeAt(0) & 0xFF)
        );

        // fatal: true → throw error nếu không phải UTF-8 hợp lệ
        // thay vì tạo ra ký tự thay thế � (U+FFFD)
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
        // Decode thất bại → text đã đúng sẵn (ví dụ "Móstoles" với ó = U+00F3)
        // Return nguyên bản
        return text;
    }
}


// ============================================
// PART 5: FETCH ORDER INFO VIA API
// ============================================

async function getOrderInfoFromAPI(thgCode) {
    try {
        const url = `${API_URL}/api/orders/info/${thgCode}`;

        console.log('[THG Extension] Fetching from API:', url);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });

        if (response.ok) {
            const data = await response.json();
            console.log('[THG Extension] API response:', data);
            return data;
        } else {
            console.error('[THG Extension] API error:', response.status);
            return null;
        }
    } catch (error) {
        console.error('[THG Extension] Error fetching from API:', error);
        return null;
    }
}

// ============================================
// PART 6: GET ORDER DATA (UPDATED WITH REQUEST ID)
// ============================================

async function getOrderData(selector, codeThg) {
    try {
        console.log('[THG Extension] Getting data from ECOUNT, Code-THG:', codeThg);

        const jsonData = await getXExtendResponse(selector, codeThg);
        const parsedData = parseEcountData(jsonData);

        if (parsedData) {
            // ✅ Verify: Kiểm tra erpOrderCode có khớp với Code-THG không
            if (parsedData.erpOrderCode !== codeThg) {
                console.error('[THG Extension] ❌ MISMATCH!', {
                    expected: codeThg,
                    received: parsedData.erpOrderCode,
                    selector
                });
                
                return {
                    success: false,
                    error: `Order code mismatch: expected ${codeThg}, got ${parsedData.erpOrderCode}`,
                    selector: selector,
                    codeThg: codeThg
                };
            }

            console.log('[THG Extension] ✅ Verified:', codeThg);

            return {
                success: true,
                data: parsedData,
                source: 'ecount',
                codeThg: codeThg,
                selector: selector
            };
        }

        return {
            success: false,
            error: 'Cannot parse ECOUNT data',
            selector: selector,
            codeThg: codeThg
        };

    } catch (error) {
        console.error('[THG Extension] Error getting order data:', error);
        return {
            success: false,
            error: error.message,
            selector: selector,
            codeThg: codeThg
        };
    }
}

function findCodeThgColumnIndex() {
    const thead = document.querySelector('.wrapper-frame-body thead');
    if (!thead) return -1;

    const headers = thead.querySelectorAll('th');
    for (let i = 0; i < headers.length; i++) {
        const text = headers[i].innerText.trim();
        if (text === 'Code-THG') {
            return i;
        }
    }
    return -1;
}

function getCodeThgFromSelector(selector) {
    try {
        // selector có dạng: "row_1_sid_456" hoặc ID của link
        const link = document.querySelector('a#' + CSS.escape(selector));
        if (!link) {
            console.error('[THG Extension] Cannot find link:', selector);
            return null;
        }

        // Tìm row chứa link này
        const row = link.closest('tr[data-row-sid]');
        if (!row) {
            console.error('[THG Extension] Cannot find row for:', selector);
            return null;
        }

        // Tìm cột Code-THG
        const codeThgIndex = findCodeThgColumnIndex();
        if (codeThgIndex === -1) {
            console.error('[THG Extension] Cannot find Code-THG column');
            return null;
        }

        // Lấy cell tương ứng
        const cells = row.querySelectorAll('td');
        if (cells.length <= codeThgIndex) {
            console.error('[THG Extension] Row has not enough cells');
            return null;
        }

        const codeCell = cells[codeThgIndex];
        const codeText = codeCell.querySelector('span:not([data-status-code])').innerText.trim();

        console.log(`[THG Extension] [${selector}] Found Code-THG:`, codeText);
        return codeText;

    } catch (error) {
        console.error('[THG Extension] Error getting Code-THG:', error);
        return null;
    }
}



// ============================================
// PART 7: MODAL CREATION
// ============================================

function createOrderModal(ordersData) {
    const existingModal = document.querySelector('.yun-modal-overlay');
    if (existingModal) {
        existingModal.remove();
    }

    const overlay = document.createElement('div');
    overlay.className = 'yun-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'yun-modal';

    // Detect if orders are POD, express, or mixed
    const hasPOD = ordersData.some(o => o.data?._orderType === 'pod');
    const hasExpress = ordersData.some(o => o.data?._orderType === 'express');
    const modalTitle = hasPOD && !hasExpress
        ? `Gửi đơn xưởng - ${ordersData.length} đơn hàng`
        : hasExpress && !hasPOD
            ? `Confirm Label Purchase - ${ordersData.length} order(s)`
            : `Submit Orders - ${ordersData.length} order(s)`;
    const submitText = hasPOD && !hasExpress ? 'Gửi đơn xưởng' : hasExpress && !hasPOD ? 'Purchase Labels' : 'Submit Orders';

    const header = document.createElement('div');
    header.className = 'yun-modal-header';
    header.innerHTML = `
    <h3>${modalTitle}</h3>
    <button class="yun-modal-close">&times;</button>
  `;

    const body = document.createElement('div');
    body.className = 'yun-modal-body';

    ordersData.forEach((orderData, index) => {
        const orderType = orderData.data?._orderType || 'express';
        const orderSection = orderType === 'pod'
            ? createPODOrderSection(orderData, index)
            : createOrderSection(orderData, index);
        body.appendChild(orderSection);
    });

    const footer = document.createElement('div');
    footer.className = 'yun-modal-footer';
    footer.innerHTML = `
    <div class="yun-bulk-actions">
      <button class="yun-btn yun-btn-sm" onclick="document.querySelectorAll('.yun-order-content').forEach(el => el.classList.add('active')); document.querySelectorAll('.yun-order-toggle').forEach(btn => btn.textContent = '▲');">Expand All</button>
      <button class="yun-btn yun-btn-sm" onclick="document.querySelectorAll('.yun-order-content').forEach(el => el.classList.remove('active')); document.querySelectorAll('.yun-order-toggle').forEach(btn => btn.textContent = '▼');">Collapse All</button>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="yun-btn yun-btn-cancel">Cancel</button>
      <button class="yun-btn yun-btn-submit">${submitText}</button>
    </div>
  `;

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const closeBtn = header.querySelector('.yun-modal-close');
    const cancelBtn = footer.querySelector('.yun-btn-cancel');
    const submitBtn = footer.querySelector('.yun-btn-submit');

    setupApplyToAllButtons(modal);

    closeBtn.onclick = () => overlay.remove();
    cancelBtn.onclick = () => overlay.remove();
    // overlay.onclick = (e) => {
    //     if (e.target === overlay) overlay.remove();
    // };

    submitBtn.onclick = () => handleSubmitOrders(ordersData);
}

function setupApplyToAllButtons(modal) {
    const applyButtons = modal.querySelectorAll('.apply-field-all');
    
    applyButtons.forEach(button => {
        button.style.cursor = 'pointer';
        button.title = 'Áp dụng cho tất cả đơn hàng';
        
        button.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            const field = this.getAttribute('data-key');
            if (!field) {
                return;
            }
            
            // Tìm input trong cùng section với button này
            const currentSection = this.closest('.yun-order-section');
            if (!currentSection) {
                return;
            }
            
            const currentInput = currentSection.querySelector(`[data-field="${field}"]`);
            if (!currentInput) {
                return;
            }
            
            const value = currentInput.value;
            
            // Confirm với user
            const confirmMsg = `Áp dụng giá trị "${value}" cho trường "${field}" cho tất cả ${document.querySelectorAll('.yun-order-section').length} đơn hàng?`;
            if (!confirm(confirmMsg)) {
                return;
            }
            
            // Apply cho tất cả sections
            const allSections = document.querySelectorAll('.yun-order-section');
            let updatedCount = 0;
            
            allSections.forEach(section => {
                const targetInput = section.querySelector(`[data-field="${field}"]`);
                if (targetInput && targetInput !== currentInput) {
                    targetInput.value = value;
                    
                    targetInput.dispatchEvent(new Event('change', { bubbles: true }));
                    updatedCount++;
                }
            });
            
            this.style.filter = 'brightness(0.8)';
            setTimeout(() => {
                this.style.filter = '';
            }, 200);
            
            alert(`✅ Đã áp dụng cho ${updatedCount} đơn hàng`, 'success');
        });
    });

    const inputs = document.querySelectorAll('.yun-input[data-number="1"]');
    inputs.forEach(input => {
        input.value = input.value.replace(',', '.');
        input.addEventListener('input', (e) => {
            let val = e.target.value;

            val = val.replace(',', '.');           // đổi dấu phẩy thành dấu chấm
            val = val.replace(/[^0-9.]/g, '');     // loại bỏ ký tự không phải số/dấu chấm

            const parts = val.split('.');
            if(parts.length > 2){
                val = parts[0] + '.' + parts.slice(1).join('');
            }

            e.target.value = val;
        });
    })
}

// ============================================
// PART 8: CREATE ORDER SECTION
// ============================================

function createOrderSection(orderData, index) {
    const section = document.createElement('div');
    section.className = 'yun-order-section';
    section.setAttribute('data-order-index', index);

    const data = orderData.data;
    const receiver = data.receiver;

    const maxItems = Math.max(
        data.packages?.length || 0,
        data.declarationInfo?.length || 0,
        1
    );

    section.innerHTML = `
    <div class="yun-order-header">
      <h4>#${index + 1} - ${data.erpOrderCode || 'N/A'} - ${data.customerOrderNumber}</h4>
      <button class="yun-order-toggle" onclick="this.closest('.yun-order-section').querySelector('.yun-order-content').classList.toggle('active'); this.textContent = this.textContent === '▼' ? '▲' : '▼';">▼</button>
    </div>
    
    <div class="yun-order-content ${index === 0 ? 'active' : ''}">

      <!-- Main info table -->
      <div class="yun-table-wrapper">
        <table class="yun-compact-table">
          <thead>
            <tr>
              <th style="width: 100px;">Carrier</th>
              <th style="width: 100px;">Routing Code <img class="apply-field-all" data-key="productCode" width="14" heigth="14" style="float: inline-end;" src="https://express.thgfulfill.com/uploads/apply-to-all.webp"></th>
              <th style="width: 100px;">Add. Service <img class="apply-field-all" data-key="extraServices.0.extra_code" width="14" heigth="14" style="float: inline-end;" src="https://express.thgfulfill.com/uploads/apply-to-all.webp"></th>
              <th style="width: 120px;">Label Type</th>
              <th style="width: 120px;">Weight Unit</th>
              <th style="width: 120px;">Size Unit</th>
              <th style="width: 100px;">IOSS Code</th>
              <th style="width: 100px;">Tax Number</th>
              <th style="width: 100px;">Vat Code</th>
              <th style="width: 100px;">EORI Number</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <select class="yun-input" data-field="carrier">
                  <option value="YUNEXPRESS" ${['VN-YTYCPREC', 'VNTHZXR', 'VNBKZXR', 'VNMUZXR'].includes(data.productCode) ? 'selected' : ''}>(Vietnam) YUNEXPRESS</option>
                  <option value="YUNEXPRESS_CN" ${['YTYCPREG', 'YTYCPREC', 'FZZXR', 'BKPHR', 'THPHR', 'THZXR', 'BKZXR', 'MUZXR', 'ZBZXRPH'].includes(data.productCode) ? 'selected' : ''}>(China) YUNEXPRESS</option>
                </select>
              </td>
              <td>
                <select class="yun-input" data-field="productCode" data-test="${data.productCode}">
                  <option value="">Select</option>
                  <option value="VN-YTYCPREC" ${data.productCode == 'VN-YTYCPREC' ? 'selected' : ''}>VN-YTYCPREC (YUNEXPRESS Vietnamm)</option>
                  <option value="VNTHZXR" ${data.productCode == 'VNTHZXR' ? 'selected' : ''}>VNTHZXR (YUNEXPRESS Vietnamm)</option>
                  <option value="VNBKZXR" ${data.productCode == 'VNBKZXR' ? 'selected' : ''}>VNBKZXR (YUNEXPRESS Vietnamm)</option>
                  <option value="VNMUZXR" ${data.productCode == 'VNMUZXR' ? 'selected' : ''}>VNMUZXR (YUNEXPRESS Vietnamm)</option>

                  <option value="YTYCPREG" ${data.productCode == 'YTYCPREG' ? 'selected' : ''}>YTYCPREG (YUNEXPRESS China)</option>
                  <option value="YTYCPREC" ${data.productCode == 'YTYCPREC' ? 'selected' : ''}>YTYCPREC (YUNEXPRESS China)</option>
                  <option value="FZZXR" ${data.productCode == 'FZZXR' ? 'selected' : ''}>FZZXR (YUNEXPRESS China)</option>
                  <option value="BKPHR" ${data.productCode == 'BKPHR' ? 'selected' : ''}>BKPHR (YUNEXPRESS China)</option>
                  <option value="THPHR" ${data.productCode == 'THPHR' ? 'selected' : ''}>THPHR (YUNEXPRESS China)</option>
                  <option value="THZXR" ${data.productCode == 'THZXR' ? 'selected' : ''}>THZXR (YUNEXPRESS China)</option>
                  <option value="BKZXR" ${data.productCode == 'BKZXR' ? 'selected' : ''}>BKZXR (YUNEXPRESS China)</option>
                  <option value="MUZXR" ${data.productCode == 'MUZXR' ? 'selected' : ''}>MUZXR (YUNEXPRESS China)</option>
                  <option value="ZBZXRPH" ${data.productCode == 'ZBZXRPH' ? 'selected' : ''}>ZBZXRPH (YUNEXPRESS China)</option>
                </select>
              </td>
              <td><input type="text" class="yun-input" data-field="extraServices.0.extra_code" value="${data.extraServices?.[0]?.extra_code || ''}"></td>
              <td>
                <select class="yun-input" data-field="labelType">
                  <option value="PDF" selected>PDF</option>
                  <option value="ZPL">ZPL</option>
                  <option value="PNG">PNG</option>
                </select>
              </td>
              <td><input type="text" class="yun-input" data-field="weightUnit" value="${data.weightUnit || 'KG'}"></td>
              <td><input type="text" class="yun-input" data-field="sizeUnit" value="${data.sizeUnit || 'CM'}"></td>
              <td><input type="text" class="yun-input" data-field="customsNumber.ioss_code" value="${data.customsNumber?.ioss_code || ''}"></td>
              <td><input type="text" class="yun-input" data-field="customsNumber.tax_number" value="${data.customsNumber?.tax_number || ''}"></td>
              <td><input type="text" class="yun-input" data-field="customsNumber.vat_code" value="${data.customsNumber?.vat_code || ''}"></td>
              <td><input type="text" class="yun-input" data-field="customsNumber.eori_number" value="${data.customsNumber?.eori_number || ''}"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="yun-divider">
        <span class="yun-divider-label">Receiver Info</span>
      </div>

      <!-- Receiver table -->
      <div class="yun-table-wrapper">
        <table class="yun-compact-table">
          <thead>
            <tr>
              <th style="width: 100px;">First Name</th>
              <th style="width: 100px;">Last Name</th>
              <th style="width: 100px;">Phone</th>
              <th style="width: 150px;">Email</th>
              <th style="width: 60px;">Country</th>
              <th style="width: 100px;">Province</th>
              <th style="width: 100px;">City</th>
              <th style="width: 80px;">Postal</th>
              <th style="width: 200px;">Address Line 1</th>
              <th style="width: 200px;">Address Line 2</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><input type="text" class="yun-input" data-field="receiver.firstName" value="${receiver.firstName || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.lastName" value="${receiver.lastName || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.phoneNumber" value="${receiver.phoneNumber || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.email" value="${receiver.email || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.countryCode" value="${receiver.countryCode || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.province" value="${receiver.province || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.city" value="${receiver.city || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.postalCode" value="${receiver.postalCode || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.addressLines.0" value="${receiver.addressLines?.[0] || ''}"></td>
                <td><input type="text" class="yun-input" data-field="receiver.addressLines.1" value="${receiver.addressLines?.[1] || ''}"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="yun-divider">
        <span class="yun-divider-label">Package Info</span>
      </div>

      <!-- Items table -->
      <div class="yun-table-wrapper">
        <table class="yun-compact-table">
          <thead>
            <tr>
              <th style="width: 60px;">Platform</th>
              <th style="width: 60px;">Package Length (cm)</th>
              <th style="width: 60px;">Package Width (cm)</th>
              <th style="width: 60px;">Package Height (cm)</th>
              <th style="width: 70px;">Package Weight (kg)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
                <td><input type="text" data-number="1" class="yun-input" data-field="platform.platform_name" value="${data.platform?.platform_name || ''}"></td>
                <td><input type="text" data-number="1" class="yun-input" data-field="packages.0.length" value="${data.packages?.[0]?.length || ''}"></td>
                <td><input type="text" data-number="1" class="yun-input" data-field="packages.0.width" value="${data.packages?.[0]?.width || ''}"></td>
                <td><input type="text" data-number="1" class="yun-input" data-field="packages.0.height" value="${data.packages?.[0]?.height || ''}"></td>
                <td><input type="text" data-number="1" class="yun-input" data-field="packages.0.weight" value="${data.packages?.[0]?.weight || ''}"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="yun-divider">
        <span class="yun-divider-label">Items (${maxItems})</span>
      </div>

      <div class="yun-table-wrapper">
        <table class="yun-compact-table">
          <thead>
            <tr>
              <th style="width: 30px;">#</th>
              <th style="width: 80px;">SKU</th>
              <th style="width: 150px;">Name (EN)</th>
              <th style="width: 150px;">Name (Local)</th>
              <th style="width: 50px;">Quantity</th>
              <th style="width: 60px;">Unit Weight</th>
              <th style="width: 70px;">Unit Price</th>
              <th style="width: 70px;">Selling Price</th>
              <th style="width: 80px;">HS Code</th>
              <th style="width: 50px;">Curr</th>
            </tr>
          </thead>
          <tbody>
            ${Array.from({ length: maxItems }).map((_, i) => {
                const declaration = data.declarationInfo?.[i] || {};
                return `
                  <tr>
                    <td style="text-align: center; color: #999;">${i + 1}</td>
                    <td><input type="text" class="yun-input" data-field="declarationInfo.${i}.sku_code" value="${declaration.sku_code || ''}"></td>
                    <td><input type="text" class="yun-input" data-field="declarationInfo.${i}.name_en" value="${declaration.name_en || ''}"></td>
                    <td><input type="text" class="yun-input" data-field="declarationInfo.${i}.name_local" value="${declaration.name_local || ''}"></td>
                    <td><input type="text"  data-number="1" class="yun-input" data-field="declarationInfo.${i}.quantity" value="${declaration.quantity || ''}"></td>
                    <td><input type="text"  data-number="1" class="yun-input" data-field="declarationInfo.${i}.unit_weight" value="${declaration.unit_weight || ''}"></td>
                    <td><input type="text"  data-number="1" step="0.01" class="yun-input" data-field="declarationInfo.${i}.unit_price" value="${declaration.unit_price || ''}"></td>
                    <td><input type="text"  data-number="1" step="0.01" class="yun-input" data-field="declarationInfo.${i}.selling_price" value="${declaration.selling_price || ''}"></td>
                    <td><input type="text" class="yun-input" data-field="declarationInfo.${i}.hs_code" value="${declaration.hs_code || ''}"></td>
                    <td><input type="text" class="yun-input" data-field="declarationInfo.${i}.currency" value="${declaration.currency || 'USD'}"></td>
                  </tr>
                `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

    return section;
}

// ============================================
// PART 8B: CREATE POD ORDER SECTION
// ============================================

function createPODOrderSection(orderData, index) {
    const section = document.createElement('div');
    section.className = 'yun-order-section';
    section.setAttribute('data-order-index', index);
    section.setAttribute('data-order-type', 'pod');

    const data = orderData.data;
    const receiver = data.receiver;
    const itemCount = data.items?.length || 0;

    section.innerHTML = `
    <div class="yun-order-header">
      <h4>#${index + 1} - ${data.erpOrderCode || 'N/A'} - ${data.customerOrderNumber} <span style="background: #4caf50; color: white; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-left: 8px;">POD - ${data.carrier}</span></h4>
      <button class="yun-order-toggle" onclick="this.closest('.yun-order-section').querySelector('.yun-order-content').classList.toggle('active'); this.textContent = this.textContent === '▼' ? '▲' : '▼';">▼</button>
    </div>

    <div class="yun-order-content ${index === 0 ? 'active' : ''}">

      <!-- Main info table -->
      <div class="yun-table-wrapper">
        <table class="yun-compact-table">
          <thead>
            <tr>
              <th style="width: 120px;">Carrier</th>
              <th style="width: 150px;">Shipping Method <img class="apply-field-all" data-key="shippingMethod" width="14" height="14" style="float: inline-end;" src="https://express.thgfulfill.com/uploads/apply-to-all.webp"></th>
              <th style="width: 150px;">Customer Order No.</th>
              <th style="width: 120px;">Tracking Number</th>
              <th style="width: 120px;">Shipping Label</th>
              <th style="width: 120px;">Carrier Label</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <select class="yun-input" data-field="carrier">
                  <option value="Printposs" ${data.carrier === 'Printposs' ? 'selected' : ''}>Printposs (001)</option>
                  <option value="ONOS" ${data.carrier === 'ONOS' ? 'selected' : ''}>ONOS (002)</option>
                  <option value="S2BDIY" ${data.carrier === 'S2BDIY' ? 'selected' : ''}>S2BDIY (004)</option>
                </select>
              </td>
              <td><input type="text" class="yun-input" data-field="shippingMethod" value="${data.shippingMethod || ''}"></td>
              <td><input type="text" class="yun-input" data-field="customerOrderNumber" value="${data.customerOrderNumber || ''}"></td>
              <td><input type="text" class="yun-input" data-field="tracking.trackingNumber" value="${data.tracking?.trackingNumber || ''}"></td>
              <td><input type="text" class="yun-input" data-field="tracking.linkPrint" value="${data.tracking?.linkPrint || ''}"></td>
              <td><input type="text" class="yun-input" data-field="tracking.carrier" value="${data.tracking?.carrier || ''}"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="yun-divider">
        <span class="yun-divider-label">Receiver Info</span>
      </div>

      <!-- Receiver table -->
      <div class="yun-table-wrapper">
        <table class="yun-compact-table">
          <thead>
            <tr>
              <th style="width: 100px;">First Name</th>
              <th style="width: 100px;">Last Name</th>
              <th style="width: 100px;">Phone</th>
              <th style="width: 150px;">Email</th>
              <th style="width: 60px;">Country</th>
              <th style="width: 100px;">Province</th>
              <th style="width: 100px;">City</th>
              <th style="width: 80px;">Postal</th>
              <th style="width: 200px;">Address Line 1</th>
              <th style="width: 200px;">Address Line 2</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><input type="text" class="yun-input" data-field="receiver.firstName" value="${receiver.firstName || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.lastName" value="${receiver.lastName || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.phoneNumber" value="${receiver.phoneNumber || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.email" value="${receiver.email || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.countryCode" value="${receiver.countryCode || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.province" value="${receiver.province || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.city" value="${receiver.city || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.postalCode" value="${receiver.postalCode || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.addressLines.0" value="${receiver.addressLines?.[0] || ''}"></td>
              <td><input type="text" class="yun-input" data-field="receiver.addressLines.1" value="${receiver.addressLines?.[1] || ''}"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="yun-divider">
        <span class="yun-divider-label">Items (${itemCount})</span>
      </div>

      <!-- POD Items table -->
      <div class="yun-table-wrapper">
        <table class="yun-compact-table">
          <thead>
            <tr>
              <th style="width: 30px;">#</th>
              <th style="width: 120px;">SKU</th>
              <th style="width: 60px;">Product ID</th>
              <th style="width: 180px;">Name</th>
              <th style="width: 60px;">Quantity</th>
              <th style="width: 80px;">Price</th>
              <th style="width: 250px;">Design URL</th>
              <th style="width: 250px;">Mockup URL</th>
            </tr>
          </thead>
          <tbody>
            ${(data.items || []).map((item, i) => `
              <tr>
                <td style="text-align: center; color: #999;">${i + 1}</td>
                <td><input type="text" class="yun-input" data-field="items.${i}.sku" value="${item.sku || ''}"></td>
                <td><input type="text" class="yun-input" data-field="items.${i}.product_id" value="${item.product_id || 'THG'}"></td>
                <td><input type="text" class="yun-input" data-field="items.${i}.name" value="${item.name || ''}"></td>
                <td><input type="text" data-number="1" class="yun-input" data-field="items.${i}.quantity" value="${item.quantity || ''}"></td>
                <td><input type="text" data-number="1" step="0.01" class="yun-input" data-field="items.${i}.price" value="${item.price || ''}"></td>
                <td><input type="text" class="yun-input" data-field="items.${i}.print_areas.0.value" value="${item.print_areas?.[0]?.value || ''}"></td>
                <td><input type="text" class="yun-input" data-field="items.${i}.image" value="${item.image || ''}"></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

    return section;
}


// ============================================
// PART 9: COLLECT ORDER DATA
// ============================================

function collectOrderData(section, originalData) {
    const inputs = section.querySelectorAll('.yun-input');
    const updatedData = JSON.parse(JSON.stringify(originalData.data));

    inputs.forEach(input => {
        const field = input.getAttribute('data-field');
        if (!field || input.readOnly) return;

        const value = input.value.trim();
        const fieldPath = field.split('.');

        let target = updatedData;
        for (let i = 0; i < fieldPath.length - 1; i++) {
            const key = fieldPath[i];

            // Handle array indices
            if (!isNaN(fieldPath[i + 1])) {
                const arrayIndex = parseInt(fieldPath[i + 1]);
                if (!target[key]) target[key] = [];
                if (!target[key][arrayIndex]) target[key][arrayIndex] = {};
                target = target[key][arrayIndex];
                i++; // Skip next iteration
            } else {
                if (!target[key]) target[key] = {};
                target = target[key];
            }
        }

        const lastKey = fieldPath[fieldPath.length - 1];

        // Xử lý các trường đặc biệt
        if (field === 'receiver.addressLines.0' || field === 'receiver.addressLines.1') {
            const index = field === 'receiver.addressLines.0' ? 0 : 1;
            if (!updatedData.receiver.addressLines) {
                updatedData.receiver.addressLines = [];
            }
            updatedData.receiver.addressLines[index] = value;
        } else if (input.type === 'number') {
            target[lastKey] = value ? parseFloat(value) : 0;
        } else {
            target[lastKey] = value;
        }
    });

    // **THÊM XỬ LÝ ĐẶC BIỆT: Đảm bảo extraServices luôn là mảng**
    if (updatedData.extraServices && !Array.isArray(updatedData.extraServices)) {
        const extraCode = updatedData.extraServices.extra_code || '';
        updatedData.extraServices = extraCode ? [{ extra_code: extraCode }] : [];
    }

    return updatedData;
}

// ============================================
// PART 9B: COLLECT POD ORDER DATA
// ============================================

function collectPODOrderData(section, originalData) {
    // Reuse base collection logic
    const updatedData = collectOrderData(section, originalData);

    // POD-specific: sync print_areas and design_urls from image field
    // if (updatedData.items) {
    //     updatedData.items.forEach(item => {
    //         if (item.image) {
    //             item.print_areas = [{ key: 'front', value: item.image }];
    //             item.design_urls = [{ key: 'front', value: item.image }];
    //         } else {
    //             item.print_areas = [];
    //             item.design_urls = [];
    //         }
    //         // Remove mockup from payload (used only for display)
    //         delete item.mockup;
    //     });
    // }

    // Remove internal type marker
    delete updatedData._orderType;

    return updatedData;
}

// ============================================
// PART 10: SUBMIT ORDERS
// ============================================

async function handleSubmitOrders(ordersData) {
    const submitBtn = document.querySelector('.yun-btn-submit');
    const originalText = submitBtn.innerText;
    submitBtn.disabled = true;
    submitBtn.innerText = 'Đang xử lý...';

    try {
        // Thu thập dữ liệu từ tất cả các order sections
        const processedOrders = [];

        ordersData.forEach((orderData, index) => {
            const section = document.querySelector(`[data-order-index="${index}"]`);
            const orderType = orderData.data?._orderType || 'express';

            let updatedData;
            if (orderType === 'pod') {
                updatedData = collectPODOrderData(section, orderData);
            } else {
                updatedData = collectOrderData(section, orderData);
                delete updatedData._orderType;
            }

            processedOrders.push(updatedData);
        });

        console.log('[THG Extension] Processed orders:', processedOrders);

        const response = await fetch(API_URL + '/api/orders/labels/purchase', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ orders: processedOrders })
        });

        const result = await response.json();

        if (response.ok && result.success) {
        console.log('[THG Extension] Purchase result:', result);
        alert('✅ Mua label thành công cho ' + processedOrders.length + ' đơn hàng!');
        document.querySelector('.yun-modal-overlay')?.remove();
        } else {
        console.error('[THG Extension] Purchase failed:', result);

        // Ghép lỗi gọn gàng nếu có validationErrors
        let message = result.message || 'Lỗi không xác định';
        if (result?.data?.validationErrors?.length) {
            const details = result.data.validationErrors
            .map(v => {
                const order = v.customerOrderNumber || v.erpOrderCode || `Order ${v.orderIndex + 1}`;
                const errs = v.errors.map(e => `• ${e.field}: ${e.message}`).join('\n');
                return `- ${order}:\n${errs}`;
            })
            .join('\n\n');
            message += '\n\n' + details;
        }

        alert('❌ ' + message);
        }


    } catch (error) {
        console.error('[THG Extension] Error submitting orders:', error);
        alert('❌ Có lỗi xảy ra: ' + error.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = originalText;
    }
}

const BATCH_CONFIG = {
    SIZE: 5,           // Số request mỗi batch
    DELAY: 2000,       // Delay giữa các batch (ms)
    CLICK_STAGGER: 200  // Delay giữa các click trong batch (ms)
};

function injectButton(titleElement) {
    if (document.querySelector(".buy-label-ecount-btn")) {
        return;
    }

    const button = document.createElement("button");
    button.className = "buy-label-ecount-btn";
    button.innerText = "🏷️ Mua label";

    button.onclick = async () => {
        const links = document.querySelectorAll('tbody tr[data-row-sid].active a[id*="_inv_s$data_dt_no_cell_item_sid_"]');

        if (!links || links.length === 0) {
            alert('Không tìm thấy đơn hàng nào!');
            return;
        }

        console.log('[THG Extension] Tìm thấy', links.length, 'đơn hàng');

        button.disabled = true;
        
        // Show loading overlay
        loadingOverlay.show(
            'Đang tải thông tin đơn hàng',
            `Tổng cộng ${links.length} đơn hàng`
        );

        try {
            const orderInfos = await processBatches(
                Array.from(links).map(link => link.id),
                links.length,
                BATCH_CONFIG
            );

            // Hide loading overlay
            loadingOverlay.hide();

            if (orderInfos.length === 0) {
                alert('⚠️ Không lấy được thông tin đơn hàng nào!');
                return;
            }

            console.log('[THG Extension] ✅ Hoàn thành:', orderInfos.length, 'đơn hàng');
            createOrderModal(orderInfos);

        } catch (error) {
            loadingOverlay.hide();
            console.error('[THG Extension] Error:', error);
            alert('❌ Có lỗi xảy ra: ' + error.message);
        } finally {
            button.disabled = false;
            button.innerText = "Mua label";

            // Close popup after delay
            await new Promise(resolve => setTimeout(resolve, 500));
            document.querySelector('[data-popup-id] #slipClose')?.click();
        }
    };

    titleElement.parentElement.appendChild(button);
    console.log('[THG Extension] Button injected');
}

// ============================================
// BATCH PROCESSING HELPER (WITH LOADING OVERLAY INTEGRATION)
// ============================================

async function processBatches(selectors, totalOrders, config) {
    const { SIZE, DELAY, CLICK_STAGGER } = config;
    const orderInfos = [];
    const totalBatches = Math.ceil(selectors.length / SIZE);
    
    const errors = [];
    let completedCount = 0;

    // ✅ Lấy Code-THG cho tất cả selectors trước
    const selectorWithCodes = [];
    
    for (const selector of selectors) {
        const codeThg = getCodeThgFromSelector(selector);
        if (codeThg) {
            selectorWithCodes.push({ selector, codeThg });
        } else {
            console.warn('[THG Extension] ⚠️ Cannot get Code-THG for:', selector);
            errors.push({
                success: false,
                error: 'Cannot get Code-THG',
                selector
            });
        }
    }

    console.log('[THG Extension] Found', selectorWithCodes.length, 'valid orders with Code-THG');

    // ✅ Deduplicate dựa trên Code-THG
    const uniqueItems = [];
    const seenCodes = new Set();
    
    for (const item of selectorWithCodes) {
        if (!seenCodes.has(item.codeThg)) {
            seenCodes.add(item.codeThg);
            uniqueItems.push(item);
        } else {
            console.warn('[THG Extension] ⚠️ Duplicate Code-THG detected, skipping:', item.codeThg);
        }
    }

    const duplicateCount = selectorWithCodes.length - uniqueItems.length;
    if (duplicateCount > 0) {
        console.warn(`[THG Extension] Removed ${duplicateCount} duplicate orders`);
    }

    // Process batches
    const totalValidBatches = Math.ceil(uniqueItems.length / SIZE);
    
    for (let batchIndex = 0; batchIndex < totalValidBatches; batchIndex++) {
        const start = batchIndex * SIZE;
        const end = Math.min(start + SIZE, uniqueItems.length);
        const batchItems = uniqueItems.slice(start, end);
        const batchNum = batchIndex + 1;
        
        loadingOverlay.updateText(`Đang xử lý Batch ${batchNum}/${totalValidBatches}`);
        loadingOverlay.updateSubtext(`Đơn hàng ${start + 1}-${end} / ${uniqueItems.length}`);
        
        console.log(`[THG Extension] 🚀 Batch ${batchNum}/${totalValidBatches}: Processing ${batchItems.length} orders`);

        // Create batch promises
        const batchPromises = batchItems.map((item, indexInBatch) => {
            return new Promise(resolve => {
                setTimeout(() => {
                    resolve(
                        getOrderData(item.selector, item.codeThg)
                            .then(result => {
                                if (result && result.success) {
                                    completedCount++;
                                    loadingOverlay.updateProgress(completedCount, uniqueItems.length);
                                }
                                return result;
                            })
                            .catch(err => {
                                completedCount++;
                                loadingOverlay.updateProgress(completedCount, uniqueItems.length);
                                return {
                                    success: false,
                                    error: err.message,
                                    selector: item.selector,
                                    codeThg: item.codeThg
                                };
                            })
                    );
                }, indexInBatch * CLICK_STAGGER);
            });
        });

        // Execute batch
        const batchResults = await Promise.all(batchPromises);
        
        // Collect results
        const successResults = batchResults.filter(r => r && r.success);
        const failedResults = batchResults.filter(r => r && !r.success);
        
        orderInfos.push(...successResults);
        errors.push(...failedResults);

        console.log(`[THG Extension] ✅ Batch ${batchNum}: ${successResults.length}/${batchItems.length} success, ${failedResults.length} failed`);
        
        // Delay before next batch
        if (batchIndex < totalValidBatches - 1) {
            loadingOverlay.updateSubtext(`⏸️ Chờ ${DELAY / 1000}s trước batch tiếp theo...`);
            console.log(`[THG Extension] ⏸️  Waiting ${DELAY}ms...`);
            await new Promise(resolve => setTimeout(resolve, DELAY));
        }
    }

    // Final update
    loadingOverlay.updateText('✅ Hoàn thành!');
    loadingOverlay.updateSubtext(`Đã tải ${orderInfos.length}/${uniqueItems.length} đơn hàng thành công`);
    loadingOverlay.updateProgress(uniqueItems.length, uniqueItems.length);

    // Log summary
    if (errors.length > 0) {
        console.warn('[THG Extension] ⚠️ Failed requests:', errors);
        console.warn(`[THG Extension] Success rate: ${orderInfos.length}/${uniqueItems.length} (${(orderInfos.length/uniqueItems.length*100).toFixed(1)}%)`);
    }

    await new Promise(resolve => setTimeout(resolve, 800));

    return orderInfos;
}

// ============================================
// PART 12: OBSERVER
// ============================================

function tryInjectOnMainPage() {
    const header = document.querySelector('.wrapper-frame-body #btn-header-bookmark[data-item-key="menu_name_header_data_model"]');
    if (!header) return;

    const text = header.innerText.normalize('NFC').trim();
    if (text !== "Danh sách bán hàng") return;

    // Lấy tất cả nút "Thêm mới" ở footer (thường có 2)
    const newButtons = document.querySelectorAll('#footer_toolbar_toolbar_item_new button');
    if (!newButtons.length) return;

    newButtons.forEach((btn) => {
        // Nếu đã có buy-label-btn trong cùng parent thì bỏ qua
        if (btn.parentElement.querySelector('.buy-label-ecount-btn')) return;
        injectButton(btn);
    });
}

// ============================================
// PART 13: STATUS TRACKING & DISPLAY (FIXED)
// ============================================

class StatusTracker {
    constructor() {
        this.statusCache = new Map(); // Cache status để tránh call API liên tục
        this.currentCodes = new Set(); // Track codes hiện tại
        this.renderedCodes = new Set(); // Track codes đã render để tránh render lại
        this.isProcessing = false;
        this.codeColumnIndex = -1;
        this.observer = null;
        this.debounceTimer = null;
    }

    /**
     * Tìm index của cột "Code-THG"
     */
    findCodeColumnIndex() {
        const thead = document.querySelector('.wrapper-frame-body thead');
        if (!thead) return -1;

        const headers = thead.querySelectorAll('th');
        for (let i = 0; i < headers.length; i++) {
            const text = headers[i].innerText.trim();
            if (text === 'Code-THG') {
                return i;
            }
        }
        return -1;
    }

    /**
     * Lấy tất cả codes từ tbody
     */
    getCodesFromTable() {
        if (this.codeColumnIndex === -1) {
            this.codeColumnIndex = this.findCodeColumnIndex();
            if (this.codeColumnIndex === -1) {
                return [];
            }
        }

        const tbody = document.querySelector('.wrapper-frame-body tbody');
        if (!tbody) return [];

        const rows = tbody.querySelectorAll('tr[data-row-sid]');
        const codes = [];

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length > this.codeColumnIndex) {
                const cell = cells[this.codeColumnIndex];
                const codeElement = cell.querySelector('.code-text') || cell;
                const code = codeElement.innerText.trim();
                
                if (code && code !== '' && code !== '\u00A0') {
                    codes.push({
                        code: code,
                        cell: cell,
                        row: row
                    });
                }
            }
        });

        return codes;
    }

    /**
     * Kiểm tra xem danh sách codes có thay đổi không
     */
    hasCodesChanged(newCodes) {
        const newCodeSet = new Set(newCodes.map(c => c.code));
        
        // Kiểm tra size
        if (newCodeSet.size !== this.currentCodes.size) {
            return true;
        }

        // Kiểm tra từng code
        for (const code of newCodeSet) {
            if (!this.currentCodes.has(code)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Call API để lấy status
     */
    async fetchStatuses(codes) {
        try {
            console.log('[THG Extension] Fetching statuses for', codes.length, 'orders');

            const response = await fetch(API_URL + '/api/orders/status/batch', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({
                    erp_order_codes: codes
                })
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const result = await response.json();
            
            if (result.success && result.data) {
                return result.data;
            }

            throw new Error('Invalid API response');

        } catch (error) {
            console.error('[THG Extension] Error fetching statuses:', error);
            return [];
        }
    }

    /**
     * Tạo status badge HTML
     */
    createStatusBadge(statusInfo) {
        const statusColors = {
            'waiting_creation': '#ff9800',
            'fetching_tracking': '#2196f3',
            'waiting_tracking': '#ff9800',
            'updating_tracking': '#2196f3',
            'waiting_tracking_update': '#ff9800',
            'updating_status': '#2196f3',
            'waiting_status_update': '#ff9800',
            'created': '#2196f3',
            'in_transit': '#2196f3',
            'out_for_delivery': '#2196f3',
            'completed': '#4caf50',
            'failed': '#f44336',
            'unknown': '#999'
        };

        const color = statusColors[statusInfo.status] || '#999';
        
        return `
            <div style="
                display: inline-block;
                padding: 2px 6px;
                background: ${color};
                color: white;
                border-radius: 10px;
                font-size: 10px;
                font-weight: 500;
                white-space: nowrap;
                line-height: 1.3;
            " title="${statusInfo.label}">
                ${statusInfo.label}
            </div>
        `;
    }

    /**
     * Kiểm tra cell đã có badge chưa và badge có đúng không
     */
    isCellAlreadyRendered(cell, statusInfo) {
        const existingBadge = cell.querySelector('[data-status-badge]');
        if (!existingBadge) return false;

        // Kiểm tra xem status có thay đổi không
        const currentStatus = existingBadge.getAttribute('data-status-code');
        return currentStatus === statusInfo.status;
    }

    /**
     * Cập nhật status vào cells
     */
    updateStatusInCells(codesData, statusResults) {
        let updatedCount = 0;

        statusResults.forEach(statusInfo => {
            // Bỏ qua not_found
            if (statusInfo.status === 'not_found') {
                return;
            }

            const codeData = codesData.find(c => c.code === statusInfo.erp_order_code);
            if (!codeData) return;

            const cell = codeData.cell;

            // Kiểm tra đã render đúng chưa
            if (this.isCellAlreadyRendered(cell, statusInfo)) {
                return;
            }

            // Xóa badge cũ nếu có
            const oldBadge = cell.querySelector('[data-status-badge]');
            if (oldBadge) {
                oldBadge.remove();
            }

            // Tạo container nếu chưa có
            let container = cell.querySelector('.code-status-container');
            if (!container) {
                const originalContent = cell.innerText.trim();
                
                // Tạo container với layout cải thiện
                container = document.createElement('div');
                container.className = 'code-status-container';
                container.style.cssText = `
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 4px;
                    width: 100%;
                `;
                
                // Code text phía trên
                const codeSpan = document.createElement('span');
                codeSpan.className = 'code-text';
                codeSpan.textContent = originalContent;
                codeSpan.style.cssText = `
                    font-weight: 500;
                    color: inherit;
                    width: 100%;
                `;
                
                container.appendChild(codeSpan);
                
                cell.innerHTML = '';
                cell.appendChild(container);
                
                // Set cell style để không bị overflow
                cell.style.minWidth = '140px';
                cell.style.verticalAlign = 'middle';
            }

            // Thêm badge mới phía dưới code
            const badge = document.createElement('span');
            badge.setAttribute('data-status-badge', 'true');
            badge.setAttribute('data-status-code', statusInfo.status);
            badge.innerHTML = this.createStatusBadge(statusInfo);
            container.appendChild(badge);

            // Cache status
            this.statusCache.set(statusInfo.erp_order_code, statusInfo);
            this.renderedCodes.add(statusInfo.erp_order_code);
            
            updatedCount++;
        });

        if (updatedCount > 0) {
            console.log('[THG Extension] ✅ Updated status for', updatedCount, 'orders');
        }
    }

    /**
     * Process và update statuses
     */
    async processStatuses() {
        if (this.isProcessing) {
            console.log('[THG Extension] Already processing statuses, skip...');
            return;
        }

        try {
            this.isProcessing = true;

            // Lấy codes từ table
            const codesData = this.getCodesFromTable();
            
            if (codesData.length === 0) {
                console.log('[THG Extension] No codes found in table');
                return;
            }

            const codes = codesData.map(c => c.code);

            // Kiểm tra xem có thay đổi không
            const hasChanged = this.hasCodesChanged(codesData);
            
            if (!hasChanged) {
                // Codes không đổi, nhưng vẫn cần check xem UI có cần update không
                // (trường hợp row bị re-render bởi ECount)
                const cachedStatuses = codes
                    .map(code => this.statusCache.get(code))
                    .filter(s => s !== undefined && s.status !== 'not_found');
                
                if (cachedStatuses.length > 0) {
                    this.updateStatusInCells(codesData, cachedStatuses);
                }
                return;
            }

            console.log('[THG Extension] Codes changed, fetching statuses for', codes.length, 'orders');

            // Update current codes
            this.currentCodes = new Set(codes);

            // Reset rendered codes khi có thay đổi
            this.renderedCodes.clear();

            // Fetch statuses từ API
            const statusResults = await this.fetchStatuses(codes);

            if (statusResults.length > 0) {
                // Filter out not_found
                const validStatuses = statusResults.filter(s => s.status !== 'not_found');
                
                if (validStatuses.length > 0) {
                    this.updateStatusInCells(codesData, validStatuses);
                }
            }

        } catch (error) {
            console.error('[THG Extension] Error processing statuses:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Bắt đầu observe table changes
     */
    startObserving() {
        // Dừng observer cũ nếu có
        this.stopObserving();

        // Tạo observer mới
        this.observer = new MutationObserver((mutations) => {
            // Kiểm tra xem có thay đổi quan trọng không
            const hasImportantChange = mutations.some(mutation => {
                // Chỉ quan tâm thay đổi trong tbody
                if (mutation.target.tagName === 'TBODY') return true;
                if (mutation.target.closest && mutation.target.closest('tbody')) return true;
                
                // Kiểm tra added nodes
                const hasNewRows = Array.from(mutation.addedNodes).some(node => {
                    if (node.nodeType !== 1) return false; // Chỉ element nodes
                    return node.tagName === 'TR' || (node.closest && node.closest('tbody'));
                });
                
                if (hasNewRows) return true;

                // Kiểm tra removed nodes
                const hasRemovedRows = Array.from(mutation.removedNodes).some(node => {
                    if (node.nodeType !== 1) return false;
                    return node.tagName === 'TR' || (node.closest && node.closest('tbody'));
                });

                return hasRemovedRows;
            });

            // if (hasImportantChange) {
            //     console.log('[THG Extension] Important table change detected');
                
            //     // Debounce: chờ 1000ms sau thay đổi cuối cùng (tăng từ 500ms)
            //     clearTimeout(this.debounceTimer);
            //     this.debounceTimer = setTimeout(() => {
            //         this.processStatuses();
            //     }, 1000);
            // }
        });

        // Observe wrapper-frame-body với config tối ưu
        const frameBody = document.querySelector('.wrapper-frame-body');
        if (frameBody) {
            this.observer.observe(frameBody, {
                childList: true,    // Chỉ quan tâm add/remove nodes
                subtree: true,      // Observe descendants
                attributes: false,  // Không quan tâm attribute changes
                characterData: false // Không quan tâm text changes
            });
            console.log('[THG Extension] Started observing table changes');

            // Process ngay lần đầu
            // setTimeout(() => this.processStatuses(), 1500);
        }
    }

    /**
     * Dừng observe
     */
    stopObserving() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        clearTimeout(this.debounceTimer);
    }

    /**
     * Reset tracker
     */
    reset() {
        this.stopObserving();
        this.statusCache.clear();
        this.currentCodes.clear();
        this.renderedCodes.clear();
        this.codeColumnIndex = -1;
        this.isProcessing = false;
    }
}

// Global instance
const statusTracker = new StatusTracker();

// ============================================
// PART 14: INTEGRATE STATUS TRACKER
// ============================================

/**
 * Kiểm tra và start status tracking nếu đang ở trang order list
 */
function checkAndStartStatusTracking() {
    const header = document.querySelector('.wrapper-frame-body #btn-header-bookmark[data-item-key="menu_name_header_data_model"]');
    if (!header) {
        statusTracker.stopObserving();
        return;
    }

    const text = header.innerText.normalize('NFC').trim();
    if (text === "Danh sách bán hàng") {
        // Đợi table load xong
        setTimeout(() => {
            const codeColumnIndex = statusTracker.findCodeColumnIndex();
            if (codeColumnIndex !== -1) {
                console.log('[THG Extension] Found "Code-THG" column, starting status tracking...');
                statusTracker.startObserving();
            }
        }, 500);
    } else {
        statusTracker.stopObserving();
    }
}

// ============================================
// PART 15: UPDATE MAIN OBSERVER
// ============================================

// Cập nhật observer chính để bao gồm status tracking
const observer = new MutationObserver(() => {
    tryInjectOnMainPage();
    checkAndStartStatusTracking();
});

// Start observer mới
observer.observe(document.body, { childList: true, subtree: true });

// Gọi ngay lần đầu
tryInjectOnMainPage();
checkAndStartStatusTracking();

console.log('[THG Extension] Content script loaded with status tracking');