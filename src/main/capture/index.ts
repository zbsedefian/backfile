/**
 * The adapter registry. Adding a service — ArchiveBox, Webrecorder, Perma.cc —
 * means implementing CaptureAdapter and adding it here; nothing above this file
 * needs to know the list changed.
 */

import { ServiceId } from '../../shared/types'
import { CaptureAdapter } from './types'
import { archiveIsAdapter } from './archiveIs'
import { waybackAdapter } from './wayback'
import { localAdapter } from './local'
import { videoAdapter } from './video'

const ADAPTERS: Record<ServiceId, CaptureAdapter> = {
  archiveIs: archiveIsAdapter,
  wayback: waybackAdapter,
  local: localAdapter,
  video: videoAdapter
}

export function adapterFor(service: ServiceId): CaptureAdapter {
  const adapter = ADAPTERS[service]
  if (!adapter) throw new Error(`unknown capture service: ${service}`)
  return adapter
}

export type { CaptureAdapter } from './types'
