// ==UserScript==
// @name ترجمة مباشرة + RTL - android.com Fix
// @namespace https://rb.app/
// @version 1.3.0
// @description يترجم وكل المواقع للعربية
// @match *://*/*
// @exclude *://translate.google.com/*
// @exclude *://translate.googleapis.com/*
// @grant GM_xmlhttpRequest
// @grant GM_registerMenuCommand
// @connect translate.googleapis.com
// @run-at document-idle
// ==/UserScript==

(function () {
    'use strict';
    const TARGET = 'ar';
    const cache = new Map();
    const scheduledNodes = new WeakSet();
    const translatedNodes = new WeakSet();
    const retryNodesAt = new WeakMap();
    const scheduledAttributes = new WeakMap();
    const translatedAttributes = new WeakMap();
    const retryAttributesAt = new WeakMap();
    const queue = [];
    let enabled = true;
    let processing = false;
    let failedCount = 0;
    let hideBadgeTimer;
    let retryTimer;

    // RTL فوري
    document.documentElement.dir = 'rtl';
    document.documentElement.lang = 'ar';
    const st = document.createElement('style');
    st.textContent = `html[dir="rtl"]{direction:rtl!important} body{top:0!important}`;
    document.documentElement.appendChild(st);

    // شارة صغيرة عشان تعرف ان السكريبت شغال
    const badge = document.createElement('div');
    badge.dataset.arabicrtlsBadge = '1';
    badge.textContent = 'جاري الترجمة...';
    badge.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:999999;background:#000;color:#fff;padding:6px 10px;border-radius:8px;font-size:12px;';
    document.body.appendChild(badge);

    function isArabic(t) {
        return (t.match(/[\u0600-\u06FF]/g) || []).length > t.length * 0.4;
    }

    function splitText(text, limit = 1000) {
        const chunks = [];
        let chunk = '';
        for (const part of text.match(/\S+\s*/g) || [text]) {
            if (part.length > limit) {
                if (chunk) chunks.push(chunk);
                chunk = '';
                for (let offset = 0; offset < part.length; offset += limit) {
                    const piece = part.slice(offset, offset + limit);
                    if (piece.length === limit) chunks.push(piece);
                    else chunk = piece;
                }
            } else if (chunk.length + part.length > limit) {
                chunks.push(chunk);
                chunk = part;
            } else {
                chunk += part;
            }
        }
        if (chunk) chunks.push(chunk);
        return chunks;
    }

    function translateText(text) {
        if (cache.has(text)) return cache.get(text);

        let request;
        if (text.length > 1000) {
            request = (async () => {
                const parts = [];
                for (const chunk of splitText(text)) parts.push(await translateText(chunk));
                return parts.join('');
            })();
            cache.set(text, request);
            request.catch(() => {
                if (cache.get(text) === request) cache.delete(text);
            });
            return request;
        }

        request = new Promise((resolve, reject) => {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${TARGET}&dt=t&q=${encodeURIComponent(text)}`;
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 15000,
                onload(response) {
                    try {
                        if (response.status < 200 || response.status >= 300) {
                            throw new Error(`Translation request returned HTTP ${response.status}`);
                        }
                        const data = JSON.parse(response.responseText);
                        const segments = data?.[0];
                        if (!Array.isArray(segments)) {
                            throw new Error('Translation response has an unexpected format');
                        }
                        const translated = segments.map(segment => segment?.[0] || '').join('');
                        if (!translated.trim()) {
                            throw new Error('Translation response was empty');
                        }
                        resolve(translated);
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: () => reject(new Error('Translation request failed')),
                ontimeout: () => reject(new Error('Translation request timed out')),
                onabort: () => reject(new Error('Translation request was aborted'))
            });
        });
        cache.set(text, request);
        request.catch(() => {
            if (cache.get(text) === request) cache.delete(text);
        });
        return request;
    }

    function isEligible(node) {
        const value = node.nodeValue;
        const text = value.trim();
        const parent = node.parentElement;
        if (!parent || text.length < 2) return false;
        if (isArabic(text) || !/[A-Za-z]/.test(text)) return false;
        if (parent.isContentEditable || parent.closest('script, style, code, pre, noscript, iframe, svg, input, textarea, select, [translate="no"], [data-arabicrtls-badge]')) return false;
        return true;
    }

    function isEligibleAttribute(element, name) {
        if (!['title', 'alt', 'aria-label'].includes(name)) return false;
        if (element.matches('input, textarea, select, option, script, style, code, pre, iframe, svg, [contenteditable], [translate="no"], [data-arabicrtls-badge]')) return false;
        const text = element.getAttribute(name);
        return text && text.trim().length >= 2
            && /[A-Za-z]/.test(text) && !isArabic(text);
    }

    function hasAttributeState(stateMap, element, name) {
        return stateMap.get(element)?.has(name) || false;
    }

    function attributeRetryAt(element, name) {
        return retryAttributesAt.get(element)?.get(name) || 0;
    }

    function setAttributeRetryAt(element, name, timestamp) {
        let retries = retryAttributesAt.get(element);
        if (!retries) {
            retries = new Map();
            retryAttributesAt.set(element, retries);
        }
        if (timestamp) retries.set(name, timestamp);
        else retries.delete(name);
    }

    function setAttributeState(stateMap, element, name) {
        let names = stateMap.get(element);
        if (!names) {
            names = new Set();
            stateMap.set(element, names);
        }
        names.add(name);
    }

    function getNodes(root) {
        if (!root) return [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isEligible(node) && !scheduledNodes.has(node) && !translatedNodes.has(node)
                    && (retryNodesAt.get(node) || 0) <= Date.now()
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        });
        const nodes = [];
        let node;
        while ((node = walker.nextNode()) && nodes.length < 150) {
            nodes.push(node);
        }
        return nodes;
    }

    function getAttributeJobs(root) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) return [];
        const jobs = [];
        const visitElement = element => {
            for (const name of ['title', 'alt', 'aria-label']) {
                if (isEligibleAttribute(element, name)
                    && !hasAttributeState(scheduledAttributes, element, name)
                    && !hasAttributeState(translatedAttributes, element, name)
                    && attributeRetryAt(element, name) <= Date.now()) {
                    jobs.push({ element, name });
                    if (jobs.length >= 150) return false;
                }
            }
            return true;
        };
        if (root.matches('[title], [alt], [aria-label]') && !visitElement(root)) return jobs;
        for (const element of root.querySelectorAll('[title], [alt], [aria-label]')) {
            if (!visitElement(element)) return jobs;
        }
        return jobs;
    }

    function enqueueNode(node) {
        if (!enabled || scheduledNodes.has(node) || translatedNodes.has(node)
            || (retryNodesAt.get(node) || 0) > Date.now() || !isEligible(node)) return;
        scheduledNodes.add(node);
        queue.push({ type: 'text', node });
        badge.style.display = 'block';
        clearTimeout(hideBadgeTimer);
        drainQueue();
    }

    function enqueueAttribute(element, name) {
        if (!enabled || hasAttributeState(scheduledAttributes, element, name)
            || hasAttributeState(translatedAttributes, element, name)
            || attributeRetryAt(element, name) > Date.now()
            || !isEligibleAttribute(element, name)) return;
        setAttributeState(scheduledAttributes, element, name);
        queue.push({ type: 'attribute', element, name });
        badge.style.display = 'block';
        clearTimeout(hideBadgeTimer);
        drainQueue();
    }

    function enqueueRoot(root) {
        if (!enabled || !root) return;
        const nodes = getNodes(root);
        for (const node of nodes) enqueueNode(node);
        for (const { element, name } of getAttributeJobs(root)) enqueueAttribute(element, name);
    }

    async function drainQueue() {
        if (processing) return;
        processing = true;
        try {
            while (queue.length) {
                const job = queue.shift();
                const node = job.type === 'text' ? job.node : null;
                const original = node ? node.nodeValue : job.element.getAttribute(job.name);
                const text = original.trim();
                badge.textContent = `يترجم (${queue.length + 1}) نص...`;
                try {
                    const translated = await translateText(text);
                    let completed = false;
                    if (translated === text) {
                        completed = node
                            ? node.isConnected && node.nodeValue === original
                            : job.element.isConnected && job.element.getAttribute(job.name) === original;
                    }
                    if (enabled && translated && translated !== text) {
                        const leading = original.match(/^\s*/)[0];
                        const trailing = original.match(/\s*$/)[0];
                        if (node && node.isConnected && node.nodeValue === original) {
                            node.nodeValue = `${leading}${translated}${trailing}`;
                            completed = true;
                        } else if (!node && job.element.isConnected && job.element.getAttribute(job.name) === original) {
                            job.element.setAttribute(job.name, `${leading}${translated}${trailing}`);
                            completed = true;
                        }
                    }
                    if (enabled && completed) {
                        if (node) translatedNodes.add(node);
                        else setAttributeState(translatedAttributes, job.element, job.name);
                        if (node) retryNodesAt.delete(node);
                        else setAttributeRetryAt(job.element, job.name, 0);
                    }
                } catch (error) {
                    failedCount++;
                    console.warn('[Arabic RTL translator] Translation failed:', error);
                    if (node) retryNodesAt.set(node, Date.now() + 30000);
                    else setAttributeRetryAt(job.element, job.name, Date.now() + 30000);
                }
                if (node) scheduledNodes.delete(node);
                else {
                    const names = scheduledAttributes.get(job.element);
                    names?.delete(job.name);
                }
                await new Promise(resolve => setTimeout(resolve, 80));
            }
        } finally {
            processing = false;
            if (!queue.length) {
                badge.textContent = !enabled
                    ? 'الترجمة متوقفة'
                    : failedCount
                    ? `اكتملت الترجمة، تعذرت ترجمة ${failedCount} نصوص`
                    : 'تمت الترجمة ✓';
                hideBadgeTimer = setTimeout(() => {
                    badge.style.display = 'none';
                    failedCount = 0;
                }, 5000);
                if (enabled && failedCount) {
                    clearTimeout(retryTimer);
                    retryTimer = setTimeout(() => enqueueRoot(document.body), 30000);
                }
                if (enabled) enqueueRoot(document.body);
            }
        }
    }

    // شغل اول مرة
    enqueueRoot(document.body);

    GM_registerMenuCommand('تبديل الترجمة العربية', () => {
        enabled = !enabled;
        clearTimeout(hideBadgeTimer);
        clearTimeout(retryTimer);
        if (enabled) {
            failedCount = 0;
            badge.textContent = 'جاري الترجمة...';
            badge.style.display = 'block';
            enqueueRoot(document.body);
            if (!queue.length && !processing) {
                badge.textContent = 'تمت الترجمة ✓';
                hideBadgeTimer = setTimeout(() => {
                    badge.style.display = 'none';
                }, 3000);
            }
        } else {
            while (queue.length) {
                const job = queue.shift();
                if (job.type === 'text') scheduledNodes.delete(job.node);
                else scheduledAttributes.get(job.element)?.delete(job.name);
            }
            badge.textContent = 'الترجمة متوقفة';
            badge.style.display = 'block';
            hideBadgeTimer = setTimeout(() => {
                badge.style.display = 'none';
            }, 3000);
        }
    });

    // راقب النصوص والعناصر التي تضيفها الصفحة بعد تحميلها
    new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if (mutation.type === 'attributes') {
                setAttributeRetryAt(mutation.target, mutation.attributeName, 0);
                translatedAttributes.get(mutation.target)?.delete(mutation.attributeName);
                enqueueAttribute(mutation.target, mutation.attributeName);
                return;
            }
            if (mutation.type === 'characterData') {
                retryNodesAt.delete(mutation.target);
                translatedNodes.delete(mutation.target);
                enqueueNode(mutation.target);
                return;
            }
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) enqueueRoot(node);
                else if (node.nodeType === Node.TEXT_NODE) enqueueNode(node);
            });
        });
    }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['title', 'alt', 'aria-label']
    });
})();