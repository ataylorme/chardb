import { useEffect, useRef } from "react";

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FS = `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 v_uv;
uniform vec2  u_res;
uniform float u_time;
uniform float u_reduced;
const vec3 C_HEAT  = vec3(0.847, 0.200, 0.047);
const vec3 C_PEAK  = vec3(1.000, 0.376, 0.157);
const vec3 C_WHOT  = vec3(1.000, 0.906, 0.780);
const vec3 C_EMBER = vec3(0.353, 0.059, 0.012);
const vec3 C_BG    = vec3(0.039, 0.039, 0.039);
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0; float a = 0.5;
  mat2 R = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 4; i++){ v += a * vnoise(p); p = R * p * 2.02; a *= 0.5; }
  return v;
}
float ridged(vec2 p){ float n = fbm(p); return 1.0 - abs(n * 2.0 - 1.0); }
float coalSDF(vec2 p, float t){
  float r = length(p);
  vec2 q = p * 2.1 + vec2(0.0, t * 0.015);
  float lumps = 0.10 * (fbm(q * 1.3) - 0.5)
              + 0.05 * (fbm(q * 3.1 + 11.0) - 0.5)
              + 0.02 * (fbm(q * 7.0 + 4.7)  - 0.5);
  return r - (0.42 + lumps);
}
vec3 fakeNormal(vec2 p, float sdf){
  float e = 0.004;
  float dx = coalSDF(p + vec2(e, 0.0), 0.0) - coalSDF(p - vec2(e, 0.0), 0.0);
  float dy = coalSDF(p + vec2(0.0, e), 0.0) - coalSDF(p - vec2(0.0, e), 0.0);
  vec2 grad = vec2(dx, dy) / (2.0 * e);
  float depth = clamp(-sdf, 0.0, 0.6);
  float nz = sqrt(clamp(1.0 - depth * 1.4, 0.05, 1.0));
  return normalize(vec3(-grad * 1.2, nz));
}
void main(){
  vec2 frag = (v_uv * u_res - 0.5 * u_res) / min(u_res.x, u_res.y);
  vec2 p = frag * 1.19 + vec2(0.0, 0.06);
  float t = u_reduced > 0.5 ? 0.0 : u_time;
  float aboveMask = smoothstep(0.0, 0.55, -p.y + 0.10);
  float nearMask  = smoothstep(0.55, 0.10, length(p));
  vec2  hazeUV    = vec2(p.x * 6.0, p.y * 5.0 - t * 0.9);
  float haze      = (vnoise(hazeUV) - 0.5);
  p += vec2(haze * 0.025, haze * 0.012) * aboveMask * nearMask;
  float sdf = coalSDF(p, t);
  float aa  = fwidth(sdf) * 1.2 + 1.0e-4;
  float ins = 1.0 - smoothstep(-aa, aa, sdf);
  vec3 n = fakeNormal(p, sdf);
  vec3 L = normalize(vec3(0.35, 0.85, 0.4));
  float lambert = clamp(dot(n, L), 0.0, 1.0);
  vec3 C_CRUST_C = vec3(0.060, 0.050, 0.045);
  vec3 C_CRUST_W = vec3(0.130, 0.060, 0.035);
  float tonal    = fbm(p * 1.8 + 5.5);
  vec3 crustBase = mix(C_CRUST_C, C_CRUST_W, smoothstep(0.35, 0.75, tonal));
  float crustTex = fbm(p * 9.0 + 3.7);
  vec3 crust = crustBase * (0.42 + lambert * 0.95);
  crust = mix(crust, crust * 0.55, crustTex * 0.75);
  float speck = step(0.985, hash21(floor(p * 320.0)));
  crust = mix(crust, vec3(0.18, 0.16, 0.15), speck * 0.6 * smoothstep(0.0, 0.6, n.y));
  float rA = ridged(p * 4.2 + vec2(0.0, t * 0.05));
  float rB = ridged(p * 9.5 + 17.0);
  float crackRaw = rA * 0.75 + rB * 0.35;
  float crack = pow(smoothstep(0.78, 0.99, crackRaw), 1.8);
  float heatMap = fbm(p * 1.6 + vec2(t * 0.03, -t * 0.02));
  float flicker = 0.92 + 0.08 * (fbm(vec2(t * 1.7, 3.1)) - 0.5) * 2.0;
  float emissive = crack * (0.65 + 0.55 * heatMap) * flicker;
  vec3 hot = mix(C_EMBER, C_HEAT, smoothstep(0.10, 0.50, emissive));
  hot      = mix(hot,    C_PEAK, smoothstep(0.55, 1.00, emissive));
  hot      = mix(hot,    C_WHOT, smoothstep(0.92, 1.18, emissive));
  vec3 crustWarm = mix(crust, mix(crust, C_EMBER, 0.55), heatMap * 0.30);
  vec3 coalCol = mix(crustWarm, hot, clamp(emissive * 1.4, 0.0, 1.0));
  coalCol += hot * pow(emissive, 2.0) * 0.22;
  float rim = smoothstep(0.0, 0.08, -sdf);
  coalCol *= mix(0.55, 1.0, rim);
  float coalHeat = heatMap * flicker;
  float haloIn   = exp(-max(sdf, 0.0) * 38.0) * (1.0 - ins);
  float haloOut  = exp(-max(sdf, 0.0) * 16.0) * (1.0 - ins);
  vec3 haloCol = mix(C_EMBER, C_HEAT, 0.55) * haloOut * (0.32 + 0.40 * coalHeat)
               + C_PEAK * haloIn * (0.40 + 0.30 * coalHeat) * 0.30;
  vec3 col = C_BG;
  col += haloCol;
  col = mix(col, coalCol, ins);
  float vig = smoothstep(1.25, 0.35, length(frag));
  col *= mix(0.85, 1.0, vig);
  float grain = (hash21(gl_FragCoord.xy + u_time) - 0.5) * 0.015;
  col += grain;
  gl_FragColor = vec4(col, 1.0);
}`;

export function CoalShader() {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        const canvas = canvasRef.current;
        if (!host || !canvas) return;

        const gl = canvas.getContext("webgl", {
            antialias: false,
            premultipliedAlpha: false,
            alpha: false,
        });
        if (!gl) return;

        const compile = (type: number, src: string): WebGLShader | null => {
            const s = gl.createShader(type);
            if (!s) return null;
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                gl.deleteShader(s);
                return null;
            }
            return s;
        };

        gl.getExtension("OES_standard_derivatives");
        const vs = compile(gl.VERTEX_SHADER, VS);
        const fs = compile(gl.FRAGMENT_SHADER, FS);
        if (!vs || !fs) return;
        const prog = gl.createProgram();
        if (!prog) return;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
        gl.useProgram(prog);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, "a_pos");
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        const uRes = gl.getUniformLocation(prog, "u_res");
        const uTime = gl.getUniformLocation(prog, "u_time");
        const uReduced = gl.getUniformLocation(prog, "u_reduced");

        const reducedMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
        let reduced = reducedMQ ? reducedMQ.matches : false;
        const onReducedChange = (e: MediaQueryListEvent) => {
            reduced = e.matches;
        };
        reducedMQ?.addEventListener?.("change", onReducedChange);

        host.classList.add("has-shader");

        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = Math.max(1, Math.floor(host.clientWidth * dpr));
            const h = Math.max(1, Math.floor(host.clientHeight * dpr));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            gl.viewport(0, 0, w, h);
            gl.uniform2f(uRes, w, h);
        };

        let ro: ResizeObserver | null = null;
        const hasRO = typeof ResizeObserver !== "undefined";
        if (hasRO) {
            ro = new ResizeObserver(resize);
            ro.observe(host);
        } else {
            window.addEventListener("resize", resize, { passive: true });
        }
        resize();

        let visible = true;
        let io: IntersectionObserver | null = null;
        const hasIO = typeof IntersectionObserver !== "undefined";
        if (hasIO) {
            io = new IntersectionObserver(
                entries => {
                    visible = entries[0]?.isIntersecting ?? true;
                },
                { threshold: 0.01 }
            );
            io.observe(host);
        }

        let raf = 0;
        const t0 = performance.now();
        const frame = (now: number) => {
            const t = (now - t0) / 1000;
            gl.uniform1f(uTime, t);
            gl.uniform1f(uReduced, reduced ? 1.0 : 0.0);
            if (visible && !document.hidden) {
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
            if (reduced) return;
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(raf);
            ro?.disconnect();
            io?.disconnect();
            reducedMQ?.removeEventListener?.("change", onReducedChange);
            window.removeEventListener("resize", resize);
        };
    }, []);

    return (
        <div ref={hostRef} className="ember relative w-full aspect-[460/420] sm:aspect-[460/420]" aria-hidden="true">
            <canvas ref={canvasRef} className="ember-canvas" />
        </div>
    );
}
