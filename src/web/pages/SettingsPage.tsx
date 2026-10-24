// 设置: profile, quiet hours, digest, notifications, WeChat, family members + invites, install help, logout.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { InviteResponse, SettingsBody, SettingsResponse } from '../../shared/api'
import type { Member, MemberRole, WechatMode } from '../../shared/types'
import { formatInstantZh } from '../../shared/time'
import { api, errorMessage } from '../lib/api'
import { ROLE_LABEL } from '../lib/labels'
import { disablePush, isStandalone } from '../lib/push'
import { navigate } from '../lib/router'
import { now, refreshBoard, setSignedOut, updateMe, useApp } from '../lib/store'
import { toast } from '../lib/toast'
import { InstallGuide, PushControl } from '../components/setup'
import { InvitePanel } from '../components/InvitePanel'
import { IconLogout, IconPlus } from '../components/Icons'
import { Avatar, PageHeader } from '../components/ui'

const WECHAT_MODES: Array<{ value: WechatMode; label: string }> = [
  { value: 'fallback', label: '仅在App通知失效时' },
  { value: 'both', label: '两边都发' },
  { value: 'only', label: '只发微信' },
  { value: 'off', label: '关闭' },
]

function splitAliases(s: string): string[] {
  return [...new Set(s.split(/[,，、;；\s]+/).map(a => a.trim()).filter(Boolean))].slice(0, 20)
}

function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <div className="card flex flex-col gap-3.5 p-4">
        {children}
        {footer}
      </div>
    </section>
  )
}

export function SettingsPage() {
  const app = useApp()
  const me = app.board?.me ?? app.me?.me ?? null
  const tz = app.board?.family.timezone ?? app.me?.family.timezone ?? 'UTC'
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSettings(await api.settings())
      setLoadError(null)
    } catch (e) {
      setLoadError(errorMessage(e))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const save = async (body: SettingsBody, ok = '已保存') => {
    try {
      const s = await api.saveSettings(body)
      setSettings(s)
      updateMe(s.me)
      toast(ok, 'ok')
      return true
    } catch (e) {
      toast(errorMessage(e), 'danger')
      return false
    }
  }

  if (!me) return null

  return (
    <div className="page">
      <PageHeader title="设置" />
      <div className="page-pad -mt-2">
        {loadError && <p className="mt-2 px-1 text-[14px] text-danger">{loadError}</p>}
        <ProfileCard me={settings?.me ?? me} onSave={save} />
        <TimesCard me={settings?.me ?? me} onSave={save} />
        <NotificationsCard vapidKey={app.me?.vapidPublicKey ?? null} settings={settings} onChanged={() => void load()} />
        <WechatCard settings={settings} tz={tz} onSave={save} onReload={load} />
        <FamilyCard me={me} members={app.board?.members ?? []} tz={tz} />
        <InstallCard />
        <LogoutCard />
        <p className="mt-6 text-center text-[12px] text-faint">
          {app.board?.family.name ?? '家庭同步'} · {tz}
        </p>
      </div>
    </div>
  )
}

function ProfileCard({ me, onSave }: { me: Member; onSave: (b: SettingsBody) => Promise<boolean> }) {
  const [name, setName] = useState(me.name)
  const [aliases, setAliases] = useState(me.aliases.join('、'))
  const [busy, setBusy] = useState(false)
  // primitive deps: settings reloads (e.g. the WeChat bind poll) bring a new array every time and
  // must not wipe what is being typed
  const aliasKey = me.aliases.join('、')
  useEffect(() => {
    setName(me.name)
    setAliases(aliasKey)
  }, [me.name, aliasKey])
  const dirty = name.trim() !== me.name || splitAliases(aliases).join('|') !== me.aliases.join('|')
  return (
    <Card title="我的资料">
      <div className="flex items-center gap-3">
        <Avatar member={{ ...me, name: name || me.name }} size={44} />
        <div className="min-w-0 flex-1">
          <label className="label" htmlFor="me-name">
            名字（家人怎么叫你）
          </label>
          <input id="me-name" className="input" value={name} maxLength={20} onChange={e => setName(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="me-aliases">
          别的叫法（用顿号或逗号隔开）
        </label>
        <input
          id="me-aliases"
          className="input"
          value={aliases}
          placeholder="比如：老婆、孩子妈、她"
          onChange={e => setAliases(e.target.value)}
        />
        <p className="mt-1 text-[13px] text-muted">助手听到这些称呼时，就知道是在说你。</p>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!dirty || busy || !name.trim()}
        onClick={async () => {
          setBusy(true)
          await onSave({ name: name.trim(), aliases: splitAliases(aliases) })
          setBusy(false)
        }}
      >
        {busy ? '保存中…' : '保存'}
      </button>
    </Card>
  )
}

function TimesCard({ me, onSave }: { me: Member; onSave: (b: SettingsBody) => Promise<boolean> }) {
  const [quietStart, setQuietStart] = useState(me.quietStart)
  const [quietEnd, setQuietEnd] = useState(me.quietEnd)
  const [digestOn, setDigestOn] = useState(me.digestTime !== null)
  const [digestTime, setDigestTime] = useState(me.digestTime ?? '08:00')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setQuietStart(me.quietStart)
    setQuietEnd(me.quietEnd)
    setDigestOn(me.digestTime !== null)
    setDigestTime(me.digestTime ?? '08:00')
  }, [me.quietStart, me.quietEnd, me.digestTime])
  const digest = digestOn ? digestTime : null
  const dirty = quietStart !== me.quietStart || quietEnd !== me.quietEnd || digest !== me.digestTime
  return (
    <Card title="提醒时间">
      <div>
        <span className="label">免打扰（这段时间的一般提醒会等到结束再发）</span>
        <div className="flex items-center gap-2">
          <input className="input flex-1" type="time" aria-label="免打扰开始" value={quietStart} onChange={e => setQuietStart(e.target.value)} />
          <span className="text-muted">到</span>
          <input className="input flex-1" type="time" aria-label="免打扰结束" value={quietEnd} onChange={e => setQuietEnd(e.target.value)} />
        </div>
        <p className="mt-1 text-[13px] text-muted">快到时间的事和你特意设的提醒，免打扰时也会发。</p>
      </div>
      <div>
        <label className="flex min-h-[44px] items-center justify-between gap-3">
          <span>每天发一条摘要</span>
          <input
            type="checkbox"
            className="h-6 w-6 accent-[var(--color-accent)]"
            checked={digestOn}
            onChange={e => setDigestOn(e.target.checked)}
          />
        </label>
        {digestOn && (
          <input className="input mt-1" type="time" aria-label="摘要时间" value={digestTime} onChange={e => setDigestTime(e.target.value)} />
        )}
        <p className="mt-1 text-[13px] text-muted">今天要做的、过期的、等你回复的，一条消息说清楚。</p>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!dirty || busy || !quietStart || !quietEnd || (digestOn && !digestTime)}
        onClick={async () => {
          setBusy(true)
          await onSave({ quietStart, quietEnd, digestTime: digest })
          setBusy(false)
        }}
      >
        {busy ? '保存中…' : '保存'}
      </button>
    </Card>
  )
}

function NotificationsCard({
  vapidKey,
  settings,
  onChanged,
}: {
  vapidKey: string | null
  settings: SettingsResponse | null
  onChanged: () => void
}) {
  return (
    <Card title="通知">
      <PushControl vapidKey={vapidKey} onChanged={onChanged} />
      {settings && (
        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-[14px]">
          <p>
            已开启通知的设备：<b>{settings.pushDevices}</b> 台
          </p>
          {settings.pushDevices > 0 && (
            <p className={settings.pushHealthy ? 'text-ok' : 'text-warn'}>
              {settings.pushHealthy ? '最近送达正常' : '最近一周没有成功送达，建议在手机上点「重新开启」'}
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

function WechatCard({
  settings,
  tz,
  onSave,
  onReload,
}: {
  settings: SettingsResponse | null
  tz: string
  onSave: (b: SettingsBody, ok?: string) => Promise<boolean>
  onReload: () => void
}) {
  const [bind, setBind] = useState<{ code: string; instructions: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // While a bind code is showing, poll so "已绑定" appears once the code is sent in WeChat.
  useEffect(() => {
    if (!bind || settings?.wechat.bound) return
    const id = setInterval(onReload, 5000)
    return () => clearInterval(id)
  }, [bind, settings?.wechat.bound, onReload])

  useEffect(() => {
    if (settings?.wechat.bound && bind) {
      setBind(null)
      toast('微信绑定成功', 'ok')
    }
  }, [settings?.wechat.bound, bind])

  if (!settings) return null
  const w = settings.wechat
  if (!w.available) {
    return (
      <Card title="微信提醒">
        <p className="text-[14px] text-muted">
          还没有配置微信提醒。管理员在服务器上填好微信公众号测试号（WECHAT_APPID / WECHAT_APPSECRET / WECHAT_TOKEN / WECHAT_TEMPLATE_ID）后，这里就能绑定微信，在 App 通知收不到时用微信提醒。
        </p>
      </Card>
    )
  }

  const getCode = async () => {
    setBusy(true)
    try {
      const r = await api.wechatBindCode()
      setBind(r)
    } catch (e) {
      toast(errorMessage(e), 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="微信提醒">
      <div className="flex items-center justify-between gap-3">
        <span>绑定状态</span>
        <span className={w.bound ? 'font-semibold text-ok' : 'text-muted'}>{w.bound ? '已绑定' : '未绑定'}</span>
      </div>
      <div>
        <label className="label" htmlFor="wechat-mode">
          什么时候发到微信
        </label>
        <select
          id="wechat-mode"
          className="input"
          value={w.mode}
          onChange={e => {
            const mode = e.target.value as WechatMode
            void onSave({ channels: [{ channel: 'wechat', enabled: mode !== 'off', config: { mode } }] }, '已保存')
          }}
        >
          {WECHAT_MODES.map(m => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {bind ? (
        <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
          <p className="text-[14px] text-muted">绑定码（30 分钟内有效）</p>
          <p className="text-[32px] font-bold tracking-[0.2em] tabular-nums select-all">{bind.code}</p>
          <p className="text-[15px]">{bind.instructions}</p>
          {w.followQrUrl && (
            <img src={w.followQrUrl} alt="测试号二维码" className="mx-auto w-48 rounded-lg bg-white p-1" />
          )}
          <p className="text-[13px] text-muted">
            {w.followQrUrl ? '用微信扫码关注测试号，' : '在微信里关注测试号，'}然后发送上面的文字。有效到 {formatInstantZh(bind.expiresAt, now(), tz)}。
          </p>
        </div>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={() => void getCode()}>
          {busy ? '获取中…' : w.bound ? '重新绑定微信' : '绑定微信'}
        </button>
      )}
    </Card>
  )
}

function FamilyCard({ me, members, tz }: { me: Member; members: Member[]; tz: string }) {
  const isAdult = me.role === 'adult'
  const [invite, setInvite] = useState<InviteResponse | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [aliases, setAliases] = useState('')
  const [role, setRole] = useState<MemberRole>('adult')
  const [busy, setBusy] = useState<string | null>(null)

  const create = async () => {
    if (!name.trim()) return
    setBusy('create')
    try {
      const r = await api.createMember({ name: name.trim(), aliases: splitAliases(aliases), role })
      setInvite(r)
      setAdding(false)
      setName('')
      setAliases('')
      void refreshBoard()
    } catch (e) {
      toast(errorMessage(e), 'danger')
    } finally {
      setBusy(null)
    }
  }

  const reinvite = async (m: Member) => {
    setBusy(m.id)
    try {
      setInvite(await api.inviteMember(m.id))
    } catch (e) {
      toast(errorMessage(e), 'danger')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section>
      <h2 className="section-title">家人</h2>
      <div className="card overflow-hidden">
        {members.map(m => (
          <div key={m.id} className="list-row">
            <Avatar member={m} size={36} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {m.name}
                {m.id === me.id && <span className="ml-1.5 text-[13px] font-normal text-muted">（我）</span>}
              </p>
              <p className="truncate text-[13px] text-muted">
                {ROLE_LABEL[m.role]}
                {m.aliases.length > 0 && ` · ${m.aliases.join('、')}`}
              </p>
            </div>
            {isAdult && (
              <button
                type="button"
                className="btn btn-sm btn-ghost -mr-2"
                disabled={busy === m.id}
                onClick={() => void reinvite(m)}
                aria-label={`为${m.name}的手机重新生成邀请`}
              >
                {busy === m.id ? '生成中…' : '重新邀请'}
              </button>
            )}
          </div>
        ))}
      </div>

      {isAdult && (
        <p className="mt-2 px-1 text-[13px] text-muted">
          换了手机、或从主屏幕打开时需要重新登录：点「重新邀请」，把新链接在那台手机上打开（也可以粘贴到应用的登录页）。
        </p>
      )}

      {invite && (
        <div className="mt-3">
          <InvitePanel invite={invite} tz={tz} onClose={() => setInvite(null)} />
        </div>
      )}

      {isAdult && !adding && (
        <button type="button" className="btn btn-outline mt-3 w-full" onClick={() => setAdding(true)}>
          <IconPlus size={18} />
          邀请家人
        </button>
      )}

      {isAdult && adding && (
        <form
          className="card mt-3 flex flex-col gap-3.5 p-4"
          onSubmit={e => {
            e.preventDefault()
            void create()
          }}
        >
          <div>
            <label className="label" htmlFor="new-name">
              怎么称呼 TA
            </label>
            <input
              id="new-name"
              className="input"
              autoFocus
              maxLength={20}
              placeholder="比如：老公、外婆"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="new-aliases">
              别的叫法（可不填）
            </label>
            <input
              id="new-aliases"
              className="input"
              placeholder="比如：他、孩子爸"
              value={aliases}
              onChange={e => setAliases(e.target.value)}
            />
          </div>
          <div>
            <span className="label">身份</span>
            <div className="flex gap-2">
              {(['adult', 'kid', 'relative'] as MemberRole[]).map(r => (
                <button
                  key={r}
                  type="button"
                  className={`btn flex-1 ${role === r ? 'btn-primary' : 'btn-outline'}`}
                  aria-pressed={role === r}
                  onClick={() => setRole(r)}
                >
                  {ROLE_LABEL[r]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-outline flex-1" onClick={() => setAdding(false)} disabled={busy === 'create'}>
              取消
            </button>
            <button type="submit" className="btn btn-primary flex-1" disabled={busy === 'create' || !name.trim()}>
              {busy === 'create' ? '生成中…' : '生成邀请链接'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

function InstallCard() {
  const standalone = isStandalone()
  const [open, setOpen] = useState(!standalone)
  return (
    <section>
      <h2 className="section-title">安装到手机</h2>
      <div className="card p-4">
        {standalone && <p className="text-[15px] text-ok">已经从主屏幕打开，安装好了。</p>}
        {open ? (
          <div className={standalone ? 'mt-3' : ''}>
            <InstallGuide />
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-ghost mt-1 -ml-2" onClick={() => setOpen(true)}>
            查看安装方法
          </button>
        )}
      </div>
    </section>
  )
}

function LogoutCard() {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const logout = async () => {
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 4000)
      return
    }
    setBusy(true)
    await disablePush().catch(() => undefined)
    await api.logout().catch(() => undefined)
    setSignedOut()
    navigate('/', { replace: true })
  }
  return (
    <div className="mt-6">
      <button type="button" className={`btn w-full ${confirming ? 'btn-danger' : 'btn-outline'}`} disabled={busy} onClick={() => void logout()}>
        <IconLogout size={18} />
        {busy ? '正在退出…' : confirming ? '确定退出？这台手机将不再收到通知' : '退出登录'}
      </button>
    </div>
  )
}
