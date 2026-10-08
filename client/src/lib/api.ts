/** Client for the MedChain server (scratch-code proofs, verification and relayed claims). */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new Error(`Cannot reach the MedChain server at ${API_URL}. Start it with "npm start" in the server folder.`)
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(body.error || `Server error (${res.status})`)
  return body as T
}

export type VerifyResult = {
  productId: number
  serial: number
  status: 'Invalid' | 'Genuine' | 'AlreadyClaimed' | 'Recalled'
  claimant: string | null
  product: { name: string; description: string; quantity: number }
  stage: string
  recalled: boolean
}

export type UnitInfo = {
  productId: number
  serial: number
  name: string
  state: 'None' | 'Claimed' | 'Quarantined'
  claimant: string | null
  recalled: boolean
  recalledAt: number | null
}

export type ProvenanceActor = { id: number; name: string; place: string; address: string } | null

export type Provenance = {
  id: number
  name: string
  description: string
  quantity: number
  stage: number
  stageLabel: string
  actors: {
    supplier: ProvenanceActor
    producer: ProvenanceActor
    distributor: ProvenanceActor
    seller: ProvenanceActor
  }
  timeline: Array<{
    stage: string
    actor: string | null
    actorAddress: string
    timestamp: number
    txHash: string
  }>
  recall: { active: boolean; reasonHash?: string; recalledAt?: number; deadline?: number }
}

export const api = {
  health: () => request<{ ok: boolean; chainId: number; contract: string; relayer: string }>('/api/health'),
  batch: (productId: number) =>
    request<{ id: number; name: string; quantity: number; codesUploaded: boolean }>(`/api/batches/${productId}`),
  provenance: (productId: number) => request<Provenance>(`/api/batches/${productId}/provenance`),
  uploadLeaves: (productId: number, leaves: string[]) =>
    request<{ ok: boolean; quantity: number }>(`/api/batches/${productId}/leaves`, {
      method: 'POST',
      body: JSON.stringify({ leaves }),
    }),
  // productId is optional — give it when known (e.g. from a QR link) for a faster, batch-scoped
  // lookup; omit it to search every uploaded batch for the code. Either way, only `secret` is
  // required — the server finds the matching serial itself.
  verify: (secret: string, productId?: number) =>
    request<VerifyResult>('/api/verify', {
      method: 'POST',
      body: JSON.stringify(productId != null ? { productId, secret } : { secret }),
    }),
  unit: (productId: number, serial: number) => request<UnitInfo>(`/api/units/${productId}/${serial}`),
  claimDigest: (productId: number, serial: number, claimant: string) =>
    request<{ digest: string }>(
      `/api/claim-digest?productId=${productId}&serial=${serial}&claimant=${encodeURIComponent(claimant)}`,
    ),
  claim: (body: { productId: number; serial: number; secret: string; claimant: string; signature: string }) =>
    request<{ ok: boolean; txHash: string }>('/api/claim', { method: 'POST', body: JSON.stringify(body) }),
}
