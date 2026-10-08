'use client'

import { useCallback, useEffect, useState } from 'react'
import { DashboardPageShell } from '@/components/dashboard/page-shell'
import { showNotification } from '@/components/Notification'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { type Provenance, type UnitInfo, type VerifyResult, api } from '@/lib/api'
import { parseSecret, signClaimDigest } from '@/lib/batchCodes'
import {
  type ClaimRecord,
  addClaim,
  getClaims,
  getCustomerAddress,
  getOrCreateCustomerKey,
  removeClaim,
} from '@/lib/customerStore'

const REFRESH_MS = 30_000

type ClaimStatus = { info?: UnitInfo; error?: string }

function statusView(result: VerifyResult, myAddress: string | null) {
  const mine = Boolean(result.claimant && myAddress && result.claimant.toLowerCase() === myAddress.toLowerCase())
  switch (result.status) {
    case 'Genuine':
      return {
        tone: 'border-emerald-500/40 bg-emerald-500/10',
        title: 'Genuine — first check',
        body: 'This code belongs to this batch and nobody has claimed this pack yet. Claim it to register it to this phone and get recall alerts.',
      }
    case 'AlreadyClaimed':
      return mine
        ? {
            tone: 'border-emerald-500/40 bg-emerald-500/10',
            title: 'Genuine — registered to you',
            body: 'You already claimed this pack on this device.',
          }
        : {
            tone: 'border-amber-500/40 bg-amber-500/10',
            title: 'Warning — this code was already used',
            body: 'The code is real, but someone else already claimed this pack. If you just opened it, the code may have been copied onto a fake pack. Ask your pharmacist before using it.',
          }
    case 'Recalled':
      return {
        tone: 'border-red-500/50 bg-red-500/10',
        title: 'RECALLED — do not use',
        body: 'The manufacturer has recalled this batch. Do not use this medicine. Return it to the pharmacy.',
      }
    default:
      return {
        tone: 'border-red-500/50 bg-red-500/10',
        title: 'Not genuine',
        body: 'This scratch code does not match any pack in this batch. Check the numbers you typed. If they are correct, the pack may be counterfeit.',
      }
  }
}

export default function VerifyPage() {
  const [productId, setProductId] = useState('')
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [checkedSecret, setCheckedSecret] = useState('')
  const [myAddress, setMyAddress] = useState<string | null>(null)
  const [claims, setClaims] = useState<ClaimRecord[]>([])
  const [claimStatus, setClaimStatus] = useState<Record<string, ClaimStatus>>({})
  const [lookupBatch, setLookupBatch] = useState('')
  const [lookupSerial, setLookupSerial] = useState('')
  const [lookup, setLookup] = useState<UnitInfo | null>(null)

  const [provenance, setProvenance] = useState<Provenance | null>(null)
  const [provenanceError, setProvenanceError] = useState<string | null>(null)
  const [provenanceLoading, setProvenanceLoading] = useState(false)

  const refreshClaims = useCallback(async (list: ClaimRecord[]) => {
    const entries = await Promise.all(
      list.map(async (c): Promise<[string, ClaimStatus]> => {
        try {
          return [`${c.productId}-${c.serial}`, { info: await api.unit(c.productId, c.serial) }]
        } catch (err: unknown) {
          return [`${c.productId}-${c.serial}`, { error: err instanceof Error ? err.message : String(err) }]
        }
      }),
    )
    setClaimStatus(Object.fromEntries(entries))
  }, [])

  // Load this device's claims, prefill the (hidden, internal-only) batch from a QR link
  // (?batch=1), and poll for recalls. The patient only ever types the scratch code.
  useEffect(() => {
    queueMicrotask(() => {
      const params = new URLSearchParams(window.location.search)
      if (params.get('batch')) setProductId(params.get('batch') ?? '')
      setMyAddress(getCustomerAddress())
      const list = getClaims()
      setClaims(list)
      void refreshClaims(list)
    })
    const timer = window.setInterval(() => void refreshClaims(getClaims()), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refreshClaims])

  // Loads the batch's public info (name, journey, current custodians) as soon as a valid batch ID
  // is present — including right after landing from a QR code, with no scratch code needed yet.
  useEffect(() => {
    const pid = Number(productId)
    const isValid = Number.isInteger(pid) && pid >= 1
    const timer = window.setTimeout(
      () => {
        if (!isValid) {
          setProvenance(null)
          setProvenanceError(null)
          return
        }
        setProvenanceLoading(true)
        setProvenanceError(null)
        api
          .provenance(pid)
          .then(setProvenance)
          .catch((err: unknown) => {
            setProvenance(null)
            setProvenanceError(err instanceof Error ? err.message : String(err))
          })
          .finally(() => setProvenanceLoading(false))
      },
      isValid ? 400 : 0,
    )
    return () => window.clearTimeout(timer)
  }, [productId])

  const recalledClaims = claims.filter((c) => claimStatus[`${c.productId}-${c.serial}`]?.info?.recalled)

  const handleCheck = async (e: React.FormEvent) => {
    e.preventDefault()
    const secret = parseSecret(code)
    if (!secret) {
      showNotification('The scratch code must be 64 letters/digits (0-9, A-F). Dashes are fine.', 'error')
      return
    }
    // When a QR link already supplied the batch, pass it along for a faster, batch-scoped lookup.
    // Otherwise the server searches every uploaded batch for this code — no batch ID needed either way.
    const pid = Number(productId)
    const knownBatch = Number.isInteger(pid) && pid >= 1 ? pid : undefined
    setChecking(true)
    setResult(null)
    try {
      setResult(await api.verify(secret, knownBatch))
      setCheckedSecret(secret)
    } catch (err: unknown) {
      showNotification(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setChecking(false)
    }
  }

  const handleClaim = async () => {
    if (!result || result.status !== 'Genuine') return
    setClaiming(true)
    try {
      const key = getOrCreateCustomerKey()
      setMyAddress(key.address)
      const { digest } = await api.claimDigest(result.productId, result.serial, key.address)
      const signature = signClaimDigest(digest, key.privateKey)
      const { txHash } = await api.claim({
        productId: result.productId,
        serial: result.serial,
        secret: checkedSecret,
        claimant: key.address,
        signature,
      })
      const next = addClaim({
        productId: result.productId,
        serial: result.serial,
        name: result.product.name,
        claimedAt: new Date().toISOString(),
        txHash,
      })
      setClaims(next)
      void refreshClaims(next)
      setResult(await api.verify(checkedSecret, result.productId))
      showNotification('Pack registered to this phone. You will see an alert here if it is recalled.', 'success')
    } catch (err: unknown) {
      showNotification(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setClaiming(false)
    }
  }

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault()
    const pid = Number(lookupBatch)
    const sn = Number(lookupSerial)
    if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(sn) || sn < 1) {
      showNotification('Enter a batch ID and serial number.', 'error')
      return
    }
    try {
      setLookup(await api.unit(pid, sn))
    } catch (err: unknown) {
      setLookup(null)
      showNotification(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const view = result ? statusView(result, myAddress) : null

  return (
    <DashboardPageShell heading="Verify a Pack" subheading="For patients — no wallet needed">
      <div className="mx-auto max-w-3xl space-y-6">
        {recalledClaims.length > 0 && (
          <div role="alert" className="rounded-xl border-2 border-red-500/60 bg-red-500/10 p-5">
            <h2 className="text-lg font-bold text-red-700 dark:text-red-300">Recall alert</h2>
            <p className="mt-1 text-sm">
              {recalledClaims.length === 1 ? 'A pack you registered has' : `${recalledClaims.length} packs you registered have`}{' '}
              been recalled. Do not use {recalledClaims.length === 1 ? 'it' : 'them'} — return to your pharmacy.
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {recalledClaims.map((c) => (
                <li key={`${c.productId}-${c.serial}`}>
                  {c.name} — batch #{c.productId}, serial {c.serial}
                </li>
              ))}
            </ul>
          </div>
        )}

        {provenanceLoading && !provenance && (
          <Card className="shadow-sm">
            <CardContent className="py-6 text-sm text-muted-foreground">Loading product information…</CardContent>
          </Card>
        )}

        {provenanceError && (
          <Card className="shadow-sm border-destructive/40">
            <CardContent className="py-6 text-sm text-destructive">{provenanceError}</CardContent>
          </Card>
        )}

        {provenance && (
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>{provenance.name}</CardTitle>
              <p className="text-sm text-muted-foreground">{provenance.description}</p>
            </CardHeader>
            <CardContent className="space-y-5">
              {provenance.recall.active && (
                <div role="alert" className="rounded-xl border-2 border-red-500/60 bg-red-500/10 p-4">
                  <p className="font-bold text-red-700 dark:text-red-300">This batch has been recalled</p>
                  <p className="mt-1 text-sm">Do not use any pack from this batch. Return it to your pharmacy.</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Batch ID</p>
                  <p className="font-semibold">#{provenance.id}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Pack count</p>
                  <p className="font-semibold">{provenance.quantity}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Current stage</p>
                  <p className="font-semibold">{provenance.stageLabel}</p>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-semibold">Who has handled this batch</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(['producer', 'supplier', 'distributor', 'seller'] as const).map((role) => {
                    const a = provenance.actors[role]
                    return (
                      <div key={role} className="rounded-lg border p-3">
                        <p className="text-xs capitalize text-muted-foreground">{role}</p>
                        {a ? (
                          <>
                            <p className="font-medium">{a.name}</p>
                            <p className="text-xs text-muted-foreground">{a.place}</p>
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground">Not reached this stage yet</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-semibold">Journey so far</p>
                <ol className="space-y-2">
                  {provenance.timeline.map((step, i) => (
                    <li key={step.txHash} className="flex items-start gap-3 text-sm">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                        {i + 1}
                      </span>
                      <div>
                        <p className="font-medium">
                          {step.stage}
                          {step.actor ? ` — ${step.actor}` : ''}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(step.timestamp * 1000).toLocaleString()}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Check your medicine</CardTitle>
            <p className="text-sm text-muted-foreground">
              Scratch the panel on the pack and enter the code underneath.
              {provenance ? ` Checking batch #${provenance.id} — ${provenance.name}.` : ''}
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCheck} className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="v-code" className="text-sm font-medium">Scratch code</label>
                <Input
                  id="v-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="1A2B-3C4D-…"
                  className="font-mono"
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <Button type="submit" className="w-full" disabled={checking}>
                {checking ? 'Checking…' : 'Check pack'}
              </Button>
            </form>

            {result && view && (
              <div className={`mt-4 rounded-xl border p-4 ${view.tone}`} data-testid="verify-result">
                <p className="text-lg font-bold">{view.title}</p>
                <p className="mt-1 text-sm">{view.body}</p>
                {result.status !== 'Invalid' && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {result.product.name} · batch #{result.productId} · serial {result.serial} of {result.product.quantity} ·{' '}
                    {result.stage}
                  </p>
                )}
                {result.status === 'Genuine' && (
                  <Button className="mt-3" onClick={() => void handleClaim()} disabled={claiming}>
                    {claiming ? 'Registering…' : 'Claim this pack'}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>My medicines</CardTitle>
            <Badge variant="secondary">{claims.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {claims.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Packs you claim on this device appear here. This page checks them for recalls every 30 seconds while
                open.
              </p>
            ) : (
              claims.map((c) => {
                const st = claimStatus[`${c.productId}-${c.serial}`]
                return (
                  <div key={`${c.productId}-${c.serial}`} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium">{c.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Batch #{c.productId} · serial {c.serial} · claimed {new Date(c.claimedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {st?.info?.recalled ? (
                        <Badge className="border border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300">Recalled</Badge>
                      ) : st?.info ? (
                        <Badge className="border border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">OK</Badge>
                      ) : (
                        <Badge variant="secondary">{st?.error ? 'Offline' : 'Checking…'}</Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setClaims(removeClaim(c.productId, c.serial))}
                        aria-label={`Remove ${c.name} serial ${c.serial} from this list`}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
            {myAddress && (
              <p className="pt-2 text-xs text-muted-foreground">
                This device&apos;s key: <span className="font-mono">{myAddress}</span> (no personal data is stored on-chain)
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Recall check without a scratch code</CardTitle>
            <p className="text-sm text-muted-foreground">Already threw away the scratch panel? Recall status is public.</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLookup} className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label htmlFor="l-batch" className="block text-sm font-medium">Batch ID</label>
                <Input id="l-batch" className="w-28" inputMode="numeric" value={lookupBatch} onChange={(e) => setLookupBatch(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label htmlFor="l-serial" className="block text-sm font-medium">Serial</label>
                <Input id="l-serial" className="w-28" inputMode="numeric" value={lookupSerial} onChange={(e) => setLookupSerial(e.target.value)} />
              </div>
              <Button type="submit" variant="outline">Look up</Button>
            </form>
            {lookup && (
              <p className="mt-3 text-sm" data-testid="lookup-result">
                {lookup.name}, batch #{lookup.productId}, serial {lookup.serial}:{' '}
                {lookup.recalled ? (
                  <span className="font-bold text-red-700 dark:text-red-300">RECALLED — do not use</span>
                ) : (
                  <span className="font-semibold text-emerald-700 dark:text-emerald-300">not recalled</span>
                )}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardPageShell>
  )
}
