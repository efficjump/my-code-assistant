/// <reference types="vite/client" />

import type { AssistantApi } from '@shared/contracts'

declare global {
  interface Window {
    assistant: AssistantApi
  }
}
