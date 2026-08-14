/// <reference types="vite/client" />

import type { BackfileApi } from '../preload'

declare global {
  interface Window {
    backfile: BackfileApi
  }
}

export {}
