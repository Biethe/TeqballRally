import { useState, useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import appIcon from '@/imports/icon.png'

const PARTICLES = [
  { id: 0,  x: 7,  size: 2, dur: 11.2, delay: 0 },
  { id: 1,  x: 14, size: 3, dur: 14.5, delay: 2.4 },
  { id: 2,  x: 22, size: 2, dur: 9.8,  delay: 1.1 },
  { id: 3,  x: 31, size: 2, dur: 13.1, delay: 4.6 },
  { id: 4,  x: 40, size: 3, dur: 10.6, delay: 0.7 },
  { id: 5,  x: 49, size: 2, dur: 12.3, delay: 3.3 },
  { id: 6,  x: 58, size: 2, dur: 9.2,  delay: 5.2 },
  { id: 7,  x: 66, size: 3, dur: 11.7, delay: 1.8 },
  { id: 8,  x: 75, size: 2, dur: 13.8, delay: 3.0 },
  { id: 9,  x: 83, size: 2, dur: 10.2, delay: 0.5 },
]

const NAV_ITEMS = ['CHAMPIONS', 'CHALLENGES', 'SUPPLIES', 'YOUR PROFILE', 'SETTINGS']

// ── Root ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [attractMode, setAttractMode] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const reset = () => {
      setAttractMode(false)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setAttractMode(true), 7000)
    }
    reset()
    window.addEventListener('pointerdown', reset)
    window.addEventListener('keydown', reset)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('pointerdown', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [])

  return (
    <div
      className="relative w-full h-full overflow-hidden"
      style={{ background: '#0e1d36', fontFamily: '"Exo 2", sans-serif', userSelect: 'none' }}
    >
      <ArenaEnvironment />
      <UILayer attractMode={attractMode} />
    </div>
  )
}

// ── Arena Environment ─────────────────────────────────────────────────────────
function ArenaEnvironment() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">

      {/* Wide center arena bloom */}
      <div className="arena-light absolute" style={{
        '--dur': '12s', '--delay': '0s',
        top: '-10%', left: '50%', transform: 'translateX(-50%)',
        width: '140%', height: '80%',
        background: 'radial-gradient(ellipse at 50% 20%, rgba(25,90,220,0.24) 0%, transparent 62%)',
      } as CSSProperties} />

      {/* Upper-left fill */}
      <div className="arena-light absolute" style={{
        '--dur': '9s', '--delay': '1.2s',
        top: '-20%', left: '-30%', width: '75%', height: '80%',
        background: 'radial-gradient(ellipse at 40% 5%, rgba(40,100,230,0.14) 0%, transparent 55%)',
      } as CSSProperties} />

      {/* Upper-right fill */}
      <div className="arena-light absolute" style={{
        '--dur': '11s', '--delay': '0.5s',
        top: '-20%', right: '-30%', width: '75%', height: '80%',
        background: 'radial-gradient(ellipse at 60% 5%, rgba(40,100,230,0.14) 0%, transparent 55%)',
      } as CSSProperties} />

      {/* Horizon arc */}
      <svg className="absolute pointer-events-none"
        style={{ top: '58%', left: 0, width: '100%', height: '44px', overflow: 'visible' }}
        viewBox="0 0 1000 22" preserveAspectRatio="none">
        <path className="horizon-arc-line" d="M -40 22 Q 500 -4 1040 22"
          fill="none" stroke="rgba(60,130,255,0.18)" strokeWidth="0.7" />
        <path className="horizon-arc-bloom" d="M -40 22 Q 500 -4 1040 22"
          fill="none" stroke="rgba(80,150,255,0.06)" strokeWidth="8" />
      </svg>

      {/* Teqball table — 28% height keeps it clearly in the lower zone */}
      <TeqTable />

      {/* Edge vignette */}
      <div className="absolute inset-0" style={{
        background: 'radial-gradient(ellipse at 50% 42%, transparent 38%, rgba(6,12,26,0.72) 100%)',
      }} />
      <div className="absolute top-0 left-0 bottom-0" style={{
        width: '10%',
        background: 'linear-gradient(90deg, rgba(6,12,26,0.58) 0%, transparent 100%)',
      }} />
      <div className="absolute top-0 right-0 bottom-0" style={{
        width: '10%',
        background: 'linear-gradient(270deg, rgba(6,12,26,0.58) 0%, transparent 100%)',
      }} />

      {/* Dust particles */}
      {PARTICLES.map(p => (
        <div key={p.id} className="particle absolute rounded-full bg-white"
          style={{
            left: `${p.x}%`, bottom: '30%',
            width: `${p.size}px`, height: `${p.size}px`,
            animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s`,
          }} />
      ))}
    </div>
  )
}

function TeqTable() {
  return (
    <div className="absolute" style={{ bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '130%', height: '28%' }}>
      <div style={{
        position: 'absolute', inset: 0,
        clipPath: 'polygon(20% 0%, 80% 0%, 100% 100%, 0% 100%)',
        background: 'linear-gradient(180deg, #122040 0%, #0c1830 100%)',
      }} />
      {/* Top rim highlight */}
      <div style={{
        position: 'absolute', top: 0, left: '20%', right: '20%', height: '2px',
        background: 'linear-gradient(90deg, transparent, rgba(80,140,255,0.4) 30%, rgba(140,190,255,0.5) 50%, rgba(80,140,255,0.4) 70%, transparent)',
      }} />
      {/* Orange center line */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0,
        left: '50%', transform: 'translateX(-50%)', width: '2px',
        background: 'linear-gradient(180deg, #e07520 0%, rgba(224,117,32,0.25) 100%)',
      }} />
    </div>
  )
}

// ── UI Layer ──────────────────────────────────────────────────────────────────
// Padding clears the camera punch-hole (safe-area-inset-top) and home bar
// (safe-area-inset-bottom). The two flex-1 spacers distribute leftover height
// above the logo and below the nav, keeping content off both edges.
function UILayer({ attractMode }: { attractMode: boolean }) {
  return (
    <div
      className="relative z-10 flex flex-col items-center w-full h-full"
      style={{
        padding: 'env(safe-area-inset-top, 16px) 20px env(safe-area-inset-bottom, 24px)',
        boxSizing: 'border-box',
      }}
    >
      {/* Stats bar — sits well below the front camera punch-hole */}
      <div style={{ width: '100%', marginTop: '68px' }}>
        <StatsBar />
      </div>

      {/* Upper flex spacer — pushes logo toward upper-center */}
      <div style={{ flex: 1 }} />

      {/* Brand identity */}
      <div className="flex flex-col items-center logo-entrance" style={{ gap: '8px' }}>
        <img
          src={appIcon}
          alt="TeqRallly"
          style={{
            width: 'clamp(78px, 11vh, 98px)',
            height: 'clamp(78px, 11vh, 98px)',
            borderRadius: '22%',
            objectFit: 'cover',
            boxShadow: '0 14px 44px rgba(0,0,0,0.65), 0 0 0 2px rgba(255,255,255,0.14), 0 0 0 5px rgba(255,255,255,0.05)',
          }}
        />
        <p className="logo-tagline-entrance" style={{
          fontFamily: '"Exo 2", sans-serif',
          fontWeight: 300,
          fontSize: '0.62rem',
          letterSpacing: '0.16em',
          color: 'rgba(255,255,255,0.42)',
          margin: 0,
          fontStyle: 'italic',
          textAlign: 'center',
        }}>
          Fast rallies on the curved table.
        </p>
      </div>

      {/* Fixed gap between logo and play */}
      <div style={{ height: '22px' }} />

      {/* Primary CTA */}
      <PlayButton attractMode={attractMode} />

      {/* Fixed gap between play and nav */}
      <div style={{ height: '14px' }} />

      {/* Secondary nav — wraps to 2 rows naturally on narrow screens */}
      <SecondaryNav />

      {/* Lower flex spacer — keeps nav off the very bottom */}
      <div style={{ flex: 1 }} />
    </div>
  )
}

// ── Stats Bar ─────────────────────────────────────────────────────────────────
function StatsBar() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingLeft: '6px', paddingRight: '6px' }}>
      <StatPill>
        <CoinIcon />
        <span>328</span>
      </StatPill>
      <StatPill>
        <TrophySmallIcon />
        <span>442</span>
      </StatPill>
      <StatPill rank>
        <span>ROOKIE III</span>
      </StatPill>
    </div>
  )
}

function StatPill({ children, rank }: { children: ReactNode; rank?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '5px',
      padding: rank ? '6px 14px' : '6px 11px',
      borderRadius: '20px',
      background: 'rgba(255,255,255,0.10)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      border: '1px solid rgba(255,255,255,0.24)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.20)',
      fontFamily: '"Exo 2", sans-serif',
      fontWeight: 700,
      fontSize: '0.68rem',
      letterSpacing: '0.04em',
      color: rank ? 'rgba(210,228,255,0.90)' : '#fff',
      whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
    }}>
      {children}
    </div>
  )
}

function CoinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6.5" fill="#f5c518" stroke="#c8a000" strokeWidth="0.5" />
      <text x="7" y="10.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="#7a5000">$</text>
    </svg>
  )
}

function TrophySmallIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5c518" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </svg>
  )
}

// ── Play Button ───────────────────────────────────────────────────────────────
function PlayButton({ attractMode }: { attractMode: boolean }) {
  const [pressed, setPressed] = useState(false)

  return (
    <button
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      className={attractMode && !pressed ? 'play-attract' : ''}
      style={{
        position: 'relative',
        width: 'clamp(200px, 54vw, 280px)',
        height: '58px',
        borderRadius: '29px',
        border: '2px solid rgba(255,180,60,0.42)',
        outline: 'none',
        cursor: 'pointer',
        overflow: 'hidden',
        WebkitTapHighlightColor: 'transparent',
        background: pressed
          ? 'linear-gradient(152deg, #f09848 0%, #d06518 55%, #ae4e10 100%)'
          : 'linear-gradient(152deg, #f08232 0%, #cc6014 55%, #a84c0e 100%)',
        boxShadow: pressed
          ? '0 3px 14px rgba(224,100,20,0.50), 0 1px 4px rgba(0,0,0,0.55)'
          : '0 12px 40px rgba(224,100,20,0.52), 0 4px 16px rgba(0,0,0,0.50), 0 0 0 2px rgba(255,175,55,0.28), inset 0 1px 0 rgba(255,195,90,0.42)',
        transform: pressed ? 'scale(0.96) translateY(1px)' : 'scale(1) translateY(0)',
        transition: pressed
          ? 'transform 80ms ease-out, box-shadow 80ms ease-out, background 60ms ease'
          : 'transform 160ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 160ms ease-out, background 100ms ease',
        fontFamily: '"Exo 2", sans-serif',
        fontWeight: 800,
        fontSize: 'clamp(1.1rem, 4vw, 1.35rem)',
        letterSpacing: '0.26em',
        color: '#fff',
        textTransform: 'uppercase',
      }}
    >
      <span aria-hidden="true" style={{
        position: 'absolute', top: 0, left: '10%', right: '10%',
        height: '1px', background: 'rgba(255,218,120,0.48)', borderRadius: '1px',
      }} />
      <span aria-hidden="true" style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at 50% 0%, rgba(255,210,110,0.14) 0%, transparent 60%)',
        pointerEvents: 'none',
      }} />
      <span style={{ position: 'relative', zIndex: 1 }}>PLAY</span>
    </button>
  )
}

// ── Secondary Nav ─────────────────────────────────────────────────────────────
// flex-wrap with justify-center: items fill from center and wrap to a second
// row when they exceed the container width — no overflow, no scroll.
function SecondaryNav() {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      width: '100%',
    }}>
      {NAV_ITEMS.map(label => <NavPill key={label} label={label} />)}
    </div>
  )
}

function NavPill({ label }: { label: string }) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        background: pressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.22)',
        borderRadius: '18px',
        outline: 'none',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        padding: '7px 13px',
        fontFamily: '"Exo 2", sans-serif',
        fontWeight: 600,
        fontSize: '0.58rem',
        letterSpacing: '0.08em',
        color: 'rgba(255,255,255,0.82)',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
        boxShadow: pressed
          ? '0 1px 4px rgba(0,0,0,0.20)'
          : '0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
        transform: pressed ? 'scale(0.92)' : 'scale(1)',
        opacity: pressed ? 0.65 : 1,
        transition: pressed
          ? 'transform 80ms ease-out, opacity 80ms ease, background 60ms ease, box-shadow 80ms ease'
          : 'transform 130ms ease-out, opacity 130ms ease, background 100ms ease, box-shadow 130ms ease',
      }}
    >
      {label}
    </button>
  )
}
