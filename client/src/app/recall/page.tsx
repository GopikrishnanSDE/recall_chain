'use client'

import { useEffect, useState } from 'react'
import Web3 from 'web3'
import { loadWeb3, getActiveAccount, getContract } from '@/lib/web3'
import { parseTransactionError } from '@/lib/errorUtils'
import { showNotification } from '@/components/Notification'
import { DashboardPageShell } from '@/components/dashboard/page-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { type ProductRow, RECALLED_BADGE_CLASS, normalizeProduct } from '@/lib/supplyChain'
import { parseSerialList } from '@/lib/serials'

type ChainContract = Awaited<ReturnType<typeof getContract>>['contract']
type Row = Record<string, unknown>

const HOLDER_STATUS = ['None', 'Pending', 'Confirmed', 'Escalated'] as const
type HolderStatusName = (typeof HOLDER_STATUS)[number]

type Closure = {
  quantity: number
  quarantined: number
  claimed: number
  claimedBeforeSale: number
  unaccounted: number
  holdersTotal: number
  holdersAcknowledged: number
  holdersEscalated: number
  holdersPending: number
}

type BatchView = {
  product: ProductRow
  manufacturer: string
  recalled: boolean
  recalledAt: number
  deadline: number
  reasonHash: string
  myStatus: HolderStatusName
  holders: { address: string; status: HolderStatusName; missed: number }[]
  closure: Closure | null
}

const n = (v: unknown) => Number(v ?? 0)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** closureReport returns one struct; web3 may hand it back directly or wrapped. */
function toClosure(raw: unknown): Closure {
  let r = raw as Row
  if (r && !('quantity' in r)) r = ((r.rep ?? r[0]) as Row) ?? r
  return {
    quantity: n(r.quantity),
    quarantined: n(r.quarantined),
    claimed: n(r.claimed),
    claimedBeforeSale: n(r.claimedBeforeSale),
    unaccounted: n(r.unaccounted),
    holdersTotal: n(r.holdersTotal),
    holdersAcknowledged: n(r.holdersAcknowledged),
    holdersEscalated: n(r.holdersEscalated),
    holdersPending: n(r.holdersPending),
  }
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`rounded-lg border p-3 ${tone ?? ''}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold">{value.toLocaleString()}</p>
    </div>
  )
}

export default function RecallPage() {
  const [loader, setLoader] = useState(true)
  const [account, setAccount] = useState('')
  const [owner, setOwner] = useState('')
  const [supplyChain, setSupplyChain] = useState<ChainContract | null>(null)
  const [batches, setBatches] = useState<BatchView[]>([])
  const [recallWindow, setRecallWindow] = useState(0)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [busy, setBusy] = useState('')

  const [recallId, setRecallId] = useState('')
  const [reason, setReason] = useState('')
  const [serialInput, setSerialInput] = useState<Record<number, string>>({})
  const [windowInput, setWindowInput] = useState('')

  // Full-page spinner only on the first load; later refreshes update in place.
  async function loadBlockchainData() {
    try {
      const { contract } = await getContract()
      const acct = await getActiveAccount()
      setSupplyChain(contract)
      setAccount(acct)
      setOwner(String(await contract.methods.owner().call()))
      setRecallWindow(n(await contract.methods.recallWindow().call()))

      const count = n(await contract.methods.productCtr().call())
      const views: BatchView[] = []
      for (let id = 1; id <= count; id++) {
        const product = normalizeProduct((await contract.methods.ProductStock(id).call()) as Row)
        const producer = (await contract.methods.PRODUCERS(product.producerId).call()) as Row
        const r = (await contract.methods.recalls(id).call()) as Row
        const recalled = Boolean(r.active)
        const myStatus = HOLDER_STATUS[n(await contract.methods.holderStatus(id, acct).call())]
        const view: BatchView = {
          product,
          manufacturer: String(producer.addr ?? ''),
          recalled,
          recalledAt: n(r.recalledAt),
          deadline: n(r.deadline),
          reasonHash: String(r.reasonHash ?? ''),
          myStatus,
          holders: [],
          closure: null,
        }
        if (recalled) {
          const holders = (await contract.methods.getRecallHolders(id).call()) as string[]
          for (const h of holders) {
            view.holders.push({
              address: h,
              status: HOLDER_STATUS[n(await contract.methods.holderStatus(id, h).call())],
              missed: n(await contract.methods.missedRecalls(h).call()),
            })
          }
          view.closure = toClosure(await contract.methods.closureReport(id).call())
        }
        views.push(view)
      }
      setBatches(views)
      setNow(Math.floor(Date.now() / 1000))
    } catch (err: unknown) {
      console.error('Error loading recall data:', err)
      showNotification(parseTransactionError(err).message, 'error')
    } finally {
      setLoader(false)
    }
  }

  useEffect(() => {
    void loadWeb3()
    queueMicrotask(() => {
      void loadBlockchainData()
    })
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])

  async function send(label: string, fn: (c: ChainContract, from: string) => Promise<void>, success: string) {
    if (!supplyChain) {
      showNotification('Contract not ready. Refresh the page.', 'error')
      return
    }
    setBusy(label)
    try {
      const from = await getActiveAccount()
      await fn(supplyChain, from)
      showNotification(success, 'success')
      await loadBlockchainData()
    } catch (err: unknown) {
      console.error(`${label} failed:`, err)
      showNotification(parseTransactionError(err).message, 'error')
    } finally {
      setBusy('')
    }
  }

  const myBatches = batches.filter((b) => !b.recalled && account && sameAddr(b.manufacturer, account))
  const recalled = batches.filter((b) => b.recalled)
  const myDuties = recalled.filter((b) => b.myStatus === 'Pending' || b.myStatus === 'Escalated')
  const isOwner = Boolean(account && owner && sameAddr(account, owner))

  const handleRecall = (e: React.FormEvent) => {
    e.preventDefault()
    const id = Number(recallId)
    if (!myBatches.some((b) => Number(b.product.id) === id)) {
      showNotification('Pick one of your own batches that is not already recalled.', 'error')
      return
    }
    if (reason.trim().length < 5) {
      showNotification('Describe the reason for the recall (at least 5 characters).', 'error')
      return
    }
    // Only a fingerprint of the reason goes on-chain; keep the full reason document off-chain.
    const reasonHash = Web3.utils.keccak256(Web3.utils.utf8ToHex(reason.trim()))
    void send(
      'recall',
      async (c, from) => {
        await c.methods.recall(id, reasonHash).send({ from })
      },
      `Batch #${id} recalled. Every holder must now confirm before the deadline.`,
    ).then(() => setReason(''))
  }

  const handleQuarantine = (b: BatchView) => {
    const id = Number(b.product.id)
    let serials: number[]
    try {
      serials = parseSerialList(serialInput[id] ?? '', Number(b.product.quantity))
    } catch (err: unknown) {
      showNotification(err instanceof Error ? err.message : String(err), 'error')
      return
    }
    void send(
      `quarantine-${id}`,
      async (c, from) => {
        await c.methods.quarantineUnits(id, serials).send({ from })
      },
      `Quarantine submitted for ${serials.length} serial(s). Packs already with customers or already quarantined are skipped — see the closure report for the totals.`,
    ).then(() => setSerialInput((s) => ({ ...s, [id]: '' })))
  }

  const handleSetWindow = (e: React.FormEvent) => {
    e.preventDefault()
    const secs = Number(windowInput)
    if (!Number.isInteger(secs) || secs < 60) {
      showNotification('The recall window must be at least 60 seconds.', 'error')
      return
    }
    void send(
      'window',
      async (c, from) => {
        await c.methods.setRecallWindow(secs).send({ from })
      },
      `New recalls will give holders ${secs} seconds to confirm.`,
    )
  }

  const formatLeft = (deadline: number) => {
    const left = deadline - now
    if (left <= 0) return 'deadline passed'
    const h = Math.floor(left / 3600)
    const m = Math.floor((left % 3600) / 60)
    const s = left % 60
    return h > 0 ? `${h}h ${m}m left` : `${m}m ${s}s left`
  }

  if (loader) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mx-auto mb-4 h-16 w-16 animate-spin rounded-full border-b-4 border-primary" />
          <h1 className="text-2xl font-bold text-foreground">Loading...</h1>
        </div>
      </div>
    )
  }

  return (
    <DashboardPageShell heading="Recalls" subheading="Recall, confirm and account for every pack">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="rounded-lg bg-muted p-2 font-mono text-xs text-muted-foreground">
          <span className="font-semibold">Account:</span> {account}
        </div>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Start a recall</CardTitle>
            <p className="text-sm text-muted-foreground">
              Only the manufacturer that created a batch can recall it. Recalls are permanent. Everyone who handled the
              batch then has {Math.round(recallWindow / 60).toLocaleString()} minute(s) to confirm.
            </p>
          </CardHeader>
          <CardContent>
            {myBatches.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This wallet has no batches it can recall. Connect the producer wallet that created the batch.
              </p>
            ) : (
              <form onSubmit={handleRecall} className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="recall-batch" className="text-sm font-medium">Batch</label>
                  <select
                    id="recall-batch"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={recallId}
                    onChange={(e) => setRecallId(e.target.value)}
                  >
                    <option value="">Select a batch…</option>
                    {myBatches.map((b) => (
                      <option key={b.product.id} value={b.product.id}>
                        #{b.product.id} — {b.product.name} ({b.product.quantity} packs)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="recall-reason" className="text-sm font-medium">Reason</label>
                  <Textarea
                    id="recall-reason"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Sterility failure found in QC re-test"
                  />
                  <p className="text-xs text-muted-foreground">Only a fingerprint (hash) of this text is stored on-chain.</p>
                </div>
                <Button type="submit" variant="destructive" disabled={busy !== ''}>
                  {busy === 'recall' ? 'Recalling…' : 'Recall batch'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {myDuties.length > 0 && (
          <Card className="border-amber-500/40 shadow-sm">
            <CardHeader>
              <CardTitle>Your recall duties</CardTitle>
              <p className="text-sm text-muted-foreground">
                Pull these packs from stock, record their serial numbers, then confirm.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {myDuties.map((b) => {
                const id = Number(b.product.id)
                return (
                  <div key={id} className="space-y-2 rounded-lg border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">#{id} — {b.product.name}</span>
                      <Badge className={RECALLED_BADGE_CLASS}>{formatLeft(b.deadline)}</Badge>
                      {b.myStatus === 'Escalated' && (
                        <Badge className={RECALLED_BADGE_CLASS}>Escalated — you missed the deadline</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-64 flex-1 space-y-1">
                        <label htmlFor={`serials-${id}`} className="text-sm font-medium">
                          Serials quarantined (1-{b.product.quantity})
                        </label>
                        <Input
                          id={`serials-${id}`}
                          placeholder="e.g. 1-20, 25, 30-32"
                          value={serialInput[id] ?? ''}
                          onChange={(e) => setSerialInput((s) => ({ ...s, [id]: e.target.value }))}
                        />
                      </div>
                      <Button variant="outline" disabled={busy !== ''} onClick={() => handleQuarantine(b)}>
                        {busy === `quarantine-${id}` ? 'Saving…' : 'Record quarantine'}
                      </Button>
                      <Button
                        disabled={busy !== ''}
                        onClick={() =>
                          void send(
                            `ack-${id}`,
                            async (c, from) => {
        await c.methods.ackRecall(id).send({ from })
      },
                            `Recall of batch #${id} confirmed.`,
                          )
                        }
                      >
                        {busy === `ack-${id}` ? 'Confirming…' : 'Confirm recall handled'}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )}

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Recall closure reports</CardTitle>
            <p className="text-sm text-muted-foreground">
              Where every pack of a recalled batch is: pulled from stock, with a customer who can be alerted, or
              unaccounted for.
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            {recalled.length === 0 ? (
              <p className="text-sm text-muted-foreground">No batches have been recalled.</p>
            ) : (
              recalled.map((b) => {
                const id = Number(b.product.id)
                const c = b.closure
                const passed = now > b.deadline
                return (
                  <div key={id} className="space-y-3 rounded-xl border p-4" data-testid={`closure-${id}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold">
                          #{id} — {b.product.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Recalled {new Date(b.recalledAt * 1000).toLocaleString()} · reason hash{' '}
                          <span className="font-mono">{b.reasonHash.slice(0, 10)}…</span>
                        </p>
                      </div>
                      <Badge className={RECALLED_BADGE_CLASS}>{formatLeft(b.deadline)}</Badge>
                    </div>

                    {c && (
                      <>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                          <Stat label="Packs in batch" value={c.quantity} />
                          <Stat label="Quarantined by holders" value={c.quarantined} tone="border-emerald-500/30 bg-emerald-500/10" />
                          <Stat label="With customers (alertable)" value={c.claimed} tone="border-sky-500/30 bg-sky-500/10" />
                          <Stat label="Unaccounted" value={c.unaccounted} tone="border-red-500/30 bg-red-500/10" />
                        </div>
                        <div className="h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                          <div className="flex h-full">
                            <div className="bg-emerald-500" style={{ width: `${(c.quarantined / c.quantity) * 100}%` }} />
                            <div className="bg-sky-500" style={{ width: `${(c.claimed / c.quantity) * 100}%` }} />
                            <div className="bg-red-500" style={{ width: `${(c.unaccounted / c.quantity) * 100}%` }} />
                          </div>
                        </div>
                        {c.claimedBeforeSale > 0 && (
                          <p className="text-sm text-amber-700 dark:text-amber-300">
                            {c.claimedBeforeSale} pack(s) were claimed before the batch reached a seller — possible theft
                            or diversion.
                          </p>
                        )}
                        <p className="text-sm text-muted-foreground">
                          Holders: {c.holdersAcknowledged} of {c.holdersTotal} confirmed · {c.holdersEscalated} escalated ·{' '}
                          {c.holdersPending} not yet confirmed
                        </p>
                      </>
                    )}

                    <div className="divide-y rounded-lg border">
                      {b.holders.map((h) => (
                        <div key={h.address} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                          <span className="font-mono">
                            {short(h.address)}
                            {sameAddr(h.address, account) ? ' (you)' : ''}
                          </span>
                          <div className="flex items-center gap-2">
                            {h.missed > 0 && <span className="text-xs text-muted-foreground">missed recalls: {h.missed}</span>}
                            <Badge variant={h.status === 'Confirmed' ? 'secondary' : 'outline'}>{h.status}</Badge>
                            {h.status === 'Pending' && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!passed || busy !== ''}
                                title={passed ? 'Record that this holder missed the deadline' : 'Available after the deadline'}
                                onClick={() =>
                                  void send(
                                    `escalate-${id}-${h.address}`,
                                    async (ct, from) => {
        await ct.methods.escalate(id, h.address).send({ from })
      },
                                    `Holder ${short(h.address)} escalated.`,
                                  )
                                }
                              >
                                Escalate
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>

        {isOwner && (
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Recall window (owner)</CardTitle>
              <p className="text-sm text-muted-foreground">
                Currently {recallWindow.toLocaleString()} seconds. Shorten it for a live demo (minimum 60). Applies to new
                recalls only.
              </p>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSetWindow} className="flex flex-wrap items-end gap-2">
                <Input
                  className="w-40"
                  inputMode="numeric"
                  placeholder="seconds"
                  value={windowInput}
                  onChange={(e) => setWindowInput(e.target.value)}
                  aria-label="Recall window in seconds"
                />
                <Button type="submit" variant="outline" disabled={busy !== ''}>
                  {busy === 'window' ? 'Saving…' : 'Set window'}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardPageShell>
  )
}
