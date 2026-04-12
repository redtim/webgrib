/**
 * LightningLayer — real-time lightning strikes from Blitzortung rendered as
 * animated flash markers on a DOM canvas overlay above the MapLibre map.
 *
 * Connects to the Blitzortung websocket (plain JSON on port 3000), accumulates
 * strikes, and renders them as radial flashes that fade over a configurable
 * max age window. Old strikes are pruned each frame.
 *
 * Like WindyLayer this is a DOM canvas overlay, not a MapLibre custom layer.
 * It creates its own <canvas> and appends it to the map's canvas container.
 */
export class LightningLayer {
    map = null;
    canvas;
    ctx = null;
    visible = true;
    animFrame = 0;
    ws = null;
    wsUrl;
    reconnectTimer = null;
    strikes = [];
    maxAge;
    flashRadius;
    constructor(opts = {}) {
        this.maxAge = opts.maxAge ?? 10 * 60 * 1000;
        this.flashRadius = opts.flashRadius ?? 6;
        this.wsUrl = opts.wsUrl ?? 'wss://ws1.blitzortung.org/';
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'gribwebview-lightning-canvas';
        const s = this.canvas.style;
        s.position = 'absolute';
        s.top = '0';
        s.left = '0';
        s.width = '100%';
        s.height = '100%';
        s.pointerEvents = 'none';
        s.opacity = String(opts.opacity ?? 0.9);
    }
    // ---------------------------------------------------------------- lifecycle
    attach(map) {
        if (this.map)
            return;
        this.map = map;
        map.getCanvasContainer().appendChild(this.canvas);
        this.syncCanvasSize();
        this.ctx = this.canvas.getContext('2d');
        map.on('resize', this.onResize);
        this.connectWs();
        if (this.visible)
            this.startRender();
    }
    detach() {
        if (!this.map)
            return;
        this.map.off('resize', this.onResize);
        this.stopRender();
        this.disconnectWs();
        if (this.canvas.parentElement)
            this.canvas.parentElement.removeChild(this.canvas);
        this.map = null;
        this.ctx = null;
    }
    isAttached() {
        return this.map !== null;
    }
    setVisible(visible) {
        if (this.visible === visible)
            return;
        this.visible = visible;
        this.canvas.style.display = visible ? '' : 'none';
        if (visible) {
            this.connectWs();
            this.startRender();
        }
        else {
            this.stopRender();
            this.disconnectWs();
        }
    }
    isVisible() {
        return this.visible;
    }
    /** Number of strikes currently held in the buffer. */
    get strikeCount() {
        return this.strikes.length;
    }
    // ---------------------------------------------------------------- websocket
    connectWs() {
        if (this.ws)
            return;
        try {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => {
                this.ws?.send(JSON.stringify({ a: 111 }));
            };
            this.ws.onmessage = (ev) => {
                try {
                    const raw = decodeLzw(ev.data);
                    const d = JSON.parse(raw);
                    if (typeof d.lat === 'number' && typeof d.lon === 'number' && typeof d.time === 'number') {
                        this.strikes.push({
                            lat: d.lat + (d.latc ?? 0),
                            lon: d.lon + (d.lonc ?? 0),
                            time: d.time / 1e6, // nanoseconds → ms
                            pol: d.pol ?? -1,
                        });
                    }
                }
                catch { /* ignore malformed */ }
            };
            this.ws.onclose = () => {
                this.ws = null;
                this.scheduleReconnect();
            };
            this.ws.onerror = () => {
                this.ws?.close();
            };
        }
        catch {
            this.scheduleReconnect();
        }
    }
    disconnectWs() {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
    }
    scheduleReconnect() {
        if (this.reconnectTimer !== null)
            return;
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            if (this.visible && this.map)
                this.connectWs();
        }, 5000);
    }
    // ---------------------------------------------------------------- rendering
    startRender() {
        if (this.animFrame)
            return;
        const tick = () => {
            this.draw();
            this.animFrame = requestAnimationFrame(tick);
        };
        this.animFrame = requestAnimationFrame(tick);
    }
    stopRender() {
        if (this.animFrame) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = 0;
        }
        this.clearCanvas();
    }
    draw() {
        const ctx = this.ctx;
        const map = this.map;
        if (!ctx || !map)
            return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.clearRect(0, 0, w, h);
        const now = Date.now();
        // Prune old strikes
        this.strikes = this.strikes.filter((s) => now - s.time < this.maxAge);
        for (const s of this.strikes) {
            const age = now - s.time;
            const t = age / this.maxAge; // 0 = just arrived, 1 = about to expire
            const pt = map.project([s.lon, s.lat]);
            const x = pt.x;
            const y = pt.y;
            // Skip off-screen
            if (x < -20 || x > w + 20 || y < -20 || y > h + 20)
                continue;
            // Flash effect: bright and large when new, dim small dot when old
            const alpha = Math.max(0, 1 - t * t); // quadratic fade
            const radius = this.flashRadius * (t < 0.05 ? 1 + (1 - t / 0.05) * 2 : 1 - t * 0.5);
            // Color: white/yellow flash for new, dimmer for old. Positive polarity = red tint.
            const isPositive = s.pol > 0;
            if (t < 0.03) {
                // Initial bright flash — radial glow
                const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 4);
                glow.addColorStop(0, isPositive ? `rgba(255,180,100,${alpha})` : `rgba(220,230,255,${alpha})`);
                glow.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = glow;
                ctx.beginPath();
                ctx.arc(x, y, radius * 4, 0, Math.PI * 2);
                ctx.fill();
            }
            // Core dot
            ctx.beginPath();
            ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
            if (isPositive) {
                ctx.fillStyle = `rgba(255,140,60,${alpha * 0.9})`;
            }
            else {
                ctx.fillStyle = `rgba(200,210,255,${alpha * 0.9})`;
            }
            ctx.fill();
        }
    }
    clearCanvas() {
        if (this.ctx)
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    syncCanvasSize() {
        if (!this.map)
            return;
        const container = this.map.getContainer();
        const w = Math.max(1, container.clientWidth);
        const h = Math.max(1, container.clientHeight);
        if (this.canvas.width !== w)
            this.canvas.width = w;
        if (this.canvas.height !== h)
            this.canvas.height = h;
    }
    onResize = () => {
        this.syncCanvasSize();
    };
}
/** LZW decompressor for Blitzortung's compressed websocket messages. */
function decodeLzw(input) {
    const chars = input.split('');
    const dict = {};
    let currChar = chars[0];
    let oldPhrase = currChar;
    const out = [currChar];
    let dictSize = 256;
    let o = dictSize;
    for (let i = 1; i < chars.length; i++) {
        const code = chars[i].charCodeAt(0);
        let phrase;
        if (dictSize > code) {
            phrase = chars[i];
        }
        else {
            phrase = dict[code] ? dict[code] : oldPhrase + currChar;
        }
        out.push(phrase);
        currChar = phrase.charAt(0);
        dict[o] = oldPhrase + currChar;
        o++;
        oldPhrase = phrase;
    }
    return out.join('');
}
