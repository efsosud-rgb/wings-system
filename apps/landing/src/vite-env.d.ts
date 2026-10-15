/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the API answers in development (`vite`); nginx's LANDING_API_BASE wins in a built page. */
  readonly VITE_LANDING_API_BASE?: string;
}
