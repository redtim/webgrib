/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production URL for the OFS CORS proxy (Cloudflare Worker). */
  readonly VITE_OFS_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
