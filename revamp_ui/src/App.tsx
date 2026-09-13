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

const CHAMPIONS_DATA = [
  {
    id: 'brazil', name: 'BRAZIL', flag: '🇧🇷', level: 6, power: 415, fullyTrained: true, upgradeCost: 0,
    stats: { REACT: 63, PWR: 50, CTRL: 68, AGIL: 68, VOL: 55, SERVE: 49, STAM: 62 },
  },
  {
    id: 'england', name: 'ENGLAND', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', level: 2, power: 436, fullyTrained: false, upgradeCost: 280,
    stats: { REACT: 60, PWR: 74, CTRL: 56, AGIL: 49, VOL: 53, SERVE: 75, STAM: 69 },
  },
  {
    id: 'france', name: 'FRANCE', flag: '🇫🇷', level: 4, power: 488, fullyTrained: false, upgradeCost: 350,
    stats: { REACT: 76, PWR: 61, CTRL: 75, AGIL: 74, VOL: 65, SERVE: 64, STAM: 73 },
  },
  {
    id: 'spain', name: 'SPAIN', flag: '🇪🇸', level: 5, power: 546, fullyTrained: false, upgradeCost: 420,
    stats: { REACT: 85, PWR: 58, CTRL: 94, AGIL: 86, VOL: 82, SERVE: 61, STAM: 80 },
  },
]

const STAT_NAMES: Record<string, string> = {
  REACT: 'Reactivity',
  PWR: 'Power',
  CTRL: 'Control',
  AGIL: 'Agility',
  VOL: 'Volley',
  SERVE: 'Serve',
  STAM: 'Stamina',
}

const CHALLENGES_DATA = [
  { id: 'long-rallies',  label: 'Play 5 long rallies', current: 0, total: 5, reward: 160 },
  { id: 'win-sets',      label: 'Win 2 sets',           current: 0, total: 2, reward: 140 },
  { id: 'play-matches',  label: 'Play 3 matches',        current: 0, total: 3, reward: 120 },
]

const MODES = [
  { id: 'friendly',     label: 'FRIENDLY',     desc: 'A quick match against the CPU',        featured: true  },
  { id: 'practice',    label: 'PRACTICE',    desc: 'Learn one skill at a time',             featured: false },
  { id: 'competition', label: 'COMPETITION', desc: 'Build your run',                        featured: false },
  { id: 'online',      label: 'ONLINE',      desc: "Play someone else, wherever they are",  featured: false },
]

const DIFFICULTIES = [
  { id: 'easy',   label: 'EASY',   desc: 'Room to learn the rally',  recommended: false },
  { id: 'normal', label: 'NORMAL', desc: 'A fair game',              recommended: true  },
  { id: 'hard',   label: 'HARD',   desc: 'Punishes a loose ball',    recommended: false },
]

const PLAYERS_DATA = [
  { id: 'france',  name: 'France',  flag: '🇫🇷', color: '#1a4fc2',
    stats: { REACT: 69, PWR: 61, CTRL: 59, AGIL: 64, VOL: 60, SERVE: 64, STAM: 62 }, foot: 'Left',  height: '1.80 m' },
  { id: 'brazil',  name: 'Brazil',  flag: '🇧🇷', color: '#1a7a3a',
    stats: { REACT: 63, PWR: 50, CTRL: 68, AGIL: 68, VOL: 55, SERVE: 49, STAM: 62 }, foot: 'Right', height: '1.78 m' },
  { id: 'spain',   name: 'Spain',   flag: '🇪🇸', color: '#b81a1a',
    stats: { REACT: 85, PWR: 58, CTRL: 94, AGIL: 86, VOL: 82, SERVE: 61, STAM: 80 }, foot: 'Right', height: '1.75 m' },
  { id: 'england', name: 'England', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', color: '#aaaaaa',
    stats: { REACT: 60, PWR: 74, CTRL: 56, AGIL: 49, VOL: 53, SERVE: 75, STAM: 69 }, foot: 'Right', height: '1.83 m' },
]

const BALLS_DATA = [
  { id: 'standard', name: 'Standard',    color: '#d8d8d8', color2: '#444444', statMod: {} as Record<string, number> },
  { id: 'surgeon',  name: 'The Surgeon', color: '#4ab0e0', color2: '#0a2030', statMod: { PWR: -2, CTRL: +5 } },
  { id: 'rocket',   name: 'The Rocket',  color: '#f08232', color2: '#200a00', statMod: { PWR: +8, CTRL: -4 } },
]

const VENUES_DATA = [
  { id: 'baseline', name: 'The Baseline', color: '#1e5c30', lineColor: 'rgba(255,255,255,0.75)' },
  { id: 'arena',    name: 'The Arena',    color: '#1a3060', lineColor: 'rgba(180,220,255,0.75)' },
  { id: 'rooftop',  name: 'The Rooftop', color: '#2a1e0e', lineColor: 'rgba(255,210,140,0.75)' },
]

// ── Root ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [attractMode, setAttractMode] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [screen, setScreen] = useState<'menu' | 'play' | 'difficulty' | 'setup' | 'champions' | 'challenges' | 'supplies' | 'profile' | 'settings' | 'settings-display' | 'settings-audio' | 'settings-gameplay' | 'settings-kit'>('menu')
  const [isExiting, setIsExiting] = useState(false)
  const [origin, setOrigin] = useState({ x: 50, y: 68 })
  const [selectedMode, setSelectedMode] = useState('friendly')
  const [selectedDifficulty, setSelectedDifficulty] = useState('normal')
  const containerRef = useRef<HTMLDivElement>(null)

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

  const toOriginPercent = (rect: DOMRect) => {
    if (!containerRef.current) return { x: 50, y: 68 }
    const c = containerRef.current.getBoundingClientRect()
    return {
      x: ((rect.left + rect.width  / 2 - c.left) / c.width)  * 100,
      y: ((rect.top  + rect.height / 2 - c.top)  / c.height) * 100,
    }
  }

  const navigateToPlay = (rect: DOMRect) => {
    setOrigin(toOriginPercent(rect))
    setScreen('play')
  }

  const navigateToChampions  = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('champions') }
  const navigateToChallenges = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('challenges') }
  const navigateToSupplies   = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('supplies') }
  const navigateToProfile    = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('profile') }
  const navigateToSettings   = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('settings') }
  const navigateToDisplay    = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('settings-display') }
  const navigateToAudio      = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('settings-audio') }
  const navigateToGameplay   = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('settings-gameplay') }
  const navigateToKit        = (rect: DOMRect) => { setOrigin(toOriginPercent(rect)); setScreen('settings-kit') }

  const navigateToDifficulty = (mode: string, rect: DOMRect) => {
    setSelectedMode(mode)
    setOrigin(toOriginPercent(rect))
    setScreen('difficulty')
  }
  const navigateToSetup = (difficulty: string, rect: DOMRect) => {
    setSelectedDifficulty(difficulty)
    setOrigin(toOriginPercent(rect))
    setScreen('setup')
  }

  const navigateBack = (rect: DOMRect, to: typeof screen = 'menu') => {
    setOrigin(toOriginPercent(rect))
    setIsExiting(true)
    setTimeout(() => { setScreen(to); setIsExiting(false) }, 380)
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden"
      style={{ background: '#0e1d36', fontFamily: '"Exo 2", sans-serif', userSelect: 'none' }}
    >
      <ArenaEnvironment />
      <UILayer
        attractMode={attractMode}
        onPlay={navigateToPlay}
        onChampions={navigateToChampions}
        onChallenges={navigateToChallenges}
        onSupplies={navigateToSupplies}
        onProfile={navigateToProfile}
        onSettings={navigateToSettings}
      />
      {['play', 'difficulty', 'setup'].includes(screen) && (
        <PlayModeScreen
          isExiting={screen === 'play' && isExiting}
          isBackground={screen !== 'play'}
          origin={origin}
          onBack={navigateBack}
          onModeSelect={navigateToDifficulty}
        />
      )}
      {['difficulty', 'setup'].includes(screen) && (
        <DifficultyScreen
          isExiting={screen === 'difficulty' && isExiting}
          isBackground={screen !== 'difficulty'}
          origin={origin}
          onBack={(r) => navigateBack(r, 'play')}
          onDifficultySelect={navigateToSetup}
        />
      )}
      {screen === 'setup' && (
        <SetupScreen
          isExiting={isExiting}
          origin={origin}
          onBack={(r) => navigateBack(r, 'difficulty')}
          mode={selectedMode}
          difficulty={selectedDifficulty}
        />
      )}
      {screen === 'champions' && (
        <ChampionsScreen
          isExiting={isExiting}
          origin={origin}
          onBack={navigateBack}
        />
      )}
      {screen === 'challenges' && (
        <ChallengesScreen isExiting={isExiting} origin={origin} onBack={navigateBack} />
      )}
      {screen === 'supplies' && (
        <SuppliesScreen isExiting={isExiting} origin={origin} onBack={navigateBack} />
      )}
      {screen === 'profile' && (
        <ProfileScreen isExiting={isExiting} origin={origin} onBack={navigateBack} />
      )}
      {screen === 'settings' && (
        <SettingsScreen isExiting={isExiting} origin={origin} onBack={navigateBack}
          onDisplay={navigateToDisplay} onAudio={navigateToAudio} onGameplay={navigateToGameplay} onKit={navigateToKit} />
      )}
      {screen === 'settings-display' && (
        <DisplayScreen isExiting={isExiting} origin={origin} onBack={(r) => navigateBack(r, 'settings')} />
      )}
      {screen === 'settings-audio' && (
        <AudioScreen isExiting={isExiting} origin={origin} onBack={(r) => navigateBack(r, 'settings')} />
      )}
      {screen === 'settings-gameplay' && (
        <GameplayScreen isExiting={isExiting} origin={origin} onBack={(r) => navigateBack(r, 'settings')} />
      )}
      {screen === 'settings-kit' && (
        <KitScreen isExiting={isExiting} origin={origin} onBack={(r) => navigateBack(r, 'settings')} />
      )}
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

      {/* Teqball table */}
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
      <div style={{
        position: 'absolute', top: 0, left: '20%', right: '20%', height: '2px',
        background: 'linear-gradient(90deg, transparent, rgba(80,140,255,0.4) 30%, rgba(140,190,255,0.5) 50%, rgba(80,140,255,0.4) 70%, transparent)',
      }} />
      <div style={{
        position: 'absolute', top: 0, bottom: 0,
        left: '50%', transform: 'translateX(-50%)', width: '2px',
        background: 'linear-gradient(180deg, #e07520 0%, rgba(224,117,32,0.25) 100%)',
      }} />
    </div>
  )
}

// ── UI Layer ──────────────────────────────────────────────────────────────────
type NavHandler = (rect: DOMRect) => void
function UILayer({ attractMode, onPlay, onChampions, onChallenges, onSupplies, onProfile, onSettings }: {
  attractMode: boolean; onPlay: NavHandler; onChampions: NavHandler; onChallenges: NavHandler
  onSupplies: NavHandler; onProfile: NavHandler; onSettings: NavHandler
}) {
  return (
    <div
      className="relative z-10 flex flex-col items-center w-full h-full"
      style={{
        padding: 'env(safe-area-inset-top, 16px) 20px env(safe-area-inset-bottom, 24px)',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ width: '100%', marginTop: '68px' }}>
        <StatsBar />
      </div>

      <div style={{ flex: 1 }} />

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

      <div style={{ height: '22px' }} />

      <PlayButton attractMode={attractMode} onPlay={onPlay} />

      <div style={{ height: '14px' }} />

      <SecondaryNav onChampions={onChampions} onChallenges={onChallenges} onSupplies={onSupplies} onProfile={onProfile} onSettings={onSettings} />

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
function PlayButton({ attractMode, onPlay }: { attractMode: boolean; onPlay: (rect: DOMRect) => void }) {
  const [pressed, setPressed] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const handlePointerUp = () => {
    setPressed(false)
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      // Small delay so press visual registers before transition launches
      setTimeout(() => onPlay(rect), 50)
    }
  }

  return (
    <button
      ref={btnRef}
      onPointerDown={() => setPressed(true)}
      onPointerUp={handlePointerUp}
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
function SecondaryNav({ onChampions, onChallenges, onSupplies, onProfile, onSettings }: {
  onChampions: NavHandler; onChallenges: NavHandler; onSupplies: NavHandler; onProfile: NavHandler; onSettings: NavHandler
}) {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      width: '100%',
    }}>
      {NAV_ITEMS.map(label => (
        <NavPill
          key={label}
          label={label}
          onClick={
            label === 'CHAMPIONS'   ? onChampions
            : label === 'CHALLENGES' ? onChallenges
            : label === 'SUPPLIES'   ? onSupplies
            : label === 'YOUR PROFILE' ? onProfile
            : label === 'SETTINGS'   ? onSettings
            : undefined
          }
        />
      ))}
    </div>
  )
}

function NavPill({ label, onClick }: { label: string; onClick?: (rect: DOMRect) => void }) {
  const [pressed, setPressed] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const handlePointerUp = () => {
    setPressed(false)
    if (onClick && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setTimeout(() => onClick(rect), 50)
    }
  }

  return (
    <button
      ref={btnRef}
      onPointerDown={() => setPressed(true)}
      onPointerUp={handlePointerUp}
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

// ── Play Mode Screen ──────────────────────────────────────────────────────────
function PlayModeScreen({
  isExiting,
  isBackground = false,
  origin,
  onBack,
  onModeSelect,
}: {
  isExiting: boolean
  isBackground?: boolean
  origin: { x: number; y: number }
  onBack: (rect: DOMRect) => void
  onModeSelect?: (modeId: string, rect: DOMRect) => void
}) {
  const backBtnRef = useRef<HTMLButtonElement>(null)
  const [backPressed, setBackPressed] = useState(false)
  const [activeCard, setActiveCard] = useState(-1)
  // Track if first reveal animation has played so we don't re-animate when returning from a child screen
  const hasRevealedRef = useRef(false)

  useEffect(() => {
    let pos = 0
    let id: ReturnType<typeof setTimeout>
    const next = () => {
      setActiveCard(pos)
      pos += 1
      if (pos < MODES.length) {
        id = setTimeout(next, 280)
      } else {
        pos = 0
        id = setTimeout(next, 3000)
      }
    }
    id = setTimeout(next, 0)
    return () => clearTimeout(id)
  }, [])

  const handleBack = () => {
    if (backBtnRef.current) {
      onBack(backBtnRef.current.getBoundingClientRect())
    }
  }

  // Determine animation class; prevent re-animation when restoring from background
  const animClass = isBackground
    ? ''
    : isExiting
      ? 'screen-collapse'
      : hasRevealedRef.current ? '' : 'screen-reveal'
  if (!isBackground && !isExiting) hasRevealedRef.current = true

  return (
    <div
      className={animClass}
      style={{
        '--ox': `${origin.x.toFixed(2)}%`,
        '--oy': `${origin.y.toFixed(2)}%`,
        position: 'absolute', inset: 0,
        background: '#0e1d36',
        fontFamily: '"Exo 2", sans-serif',
        zIndex: 20,
        overflowY: 'auto',
        ...(isBackground ? { clipPath: 'circle(150% at 50% 50%)' } : {}),
      } as CSSProperties}
    >
      {/* Shared arena backdrop — same environment, seamless transition */}
      <ArenaEnvironment />

      <div
        className="relative z-10 flex flex-col"
        style={{
          padding: 'env(safe-area-inset-bottom, 20px)',
          paddingLeft: '20px',
          paddingRight: '20px',
          paddingTop: 'calc(env(safe-area-inset-top, 16px) + 68px)',
          boxSizing: 'border-box',
          height: '100%',
        }}
      >
        {/* Top bar: logo wordmark + back button */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '20px',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
            <img src={appIcon} alt="" style={{
              width: '30px', height: '30px',
              borderRadius: '22%', objectFit: 'cover',
              boxShadow: '0 2px 8px rgba(0,0,0,0.40)',
            }} />
            <span style={{
              fontWeight: 700,
              fontSize: '0.85rem',
              color: 'rgba(255,255,255,0.76)',
              letterSpacing: '0.03em',
            }}>
              TeqRallly
            </span>
          </div>

          <button
            ref={backBtnRef}
            onPointerDown={() => setBackPressed(true)}
            onPointerUp={() => { setBackPressed(false); handleBack() }}
            onPointerLeave={() => setBackPressed(false)}
            onPointerCancel={() => setBackPressed(false)}
            style={{
              background: backPressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.22)',
              borderRadius: '18px',
              padding: '7px 14px',
              fontFamily: '"Exo 2", sans-serif',
              fontWeight: 600,
              fontSize: '0.62rem',
              letterSpacing: '0.08em',
              color: 'rgba(255,255,255,0.82)',
              textTransform: 'uppercase',
              cursor: 'pointer',
              outline: 'none',
              WebkitTapHighlightColor: 'transparent',
              boxShadow: backPressed
                ? '0 1px 4px rgba(0,0,0,0.20)'
                : '0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
              transform: backPressed ? 'scale(0.92)' : 'scale(1)',
              opacity: backPressed ? 0.65 : 1,
              transition: backPressed
                ? 'transform 80ms ease-out, opacity 80ms ease, background 60ms ease'
                : 'transform 130ms ease-out, opacity 130ms ease, background 100ms ease',
              whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
            }}
          >
            ← BACK
          </button>
        </div>

        {/* Screen heading */}
        <h1 style={{
          fontFamily: '"Exo 2", sans-serif',
          fontWeight: 900,
          fontSize: 'clamp(1.55rem, 7vw, 2rem)',
          color: '#ffffff',
          textTransform: 'uppercase',
          lineHeight: 1.05,
          margin: '0 0 14px',
          letterSpacing: '-0.01em',
          flexShrink: 0,
        }}>
          How do you<br />want to play?
        </h1>

        {/* Game mode cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {MODES.map((mode, i) => (
            <ModeCard
              key={mode.id}
              label={mode.label}
              desc={mode.desc}
              isActive={activeCard === i}
              onSelect={(mode.id === 'friendly' || mode.id === 'practice') && onModeSelect
                ? (rect) => onModeSelect(mode.id, rect)
                : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Mode Card ─────────────────────────────────────────────────────────────────
// The wave is driven by a re-keyed span: when isActive flips true, sweepKey
// increments, React re-mounts the span, and the CSS animation replays from scratch.
function ModeCard({
  label,
  desc,
  isActive,
  onSelect,
}: {
  label: string
  desc: string
  isActive: boolean
  onSelect?: (rect: DOMRect) => void
}) {
  const [pressed, setPressed] = useState(false)
  const [sweepKey, setSweepKey] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isActive) setSweepKey(k => k + 1)
  }, [isActive])

  const handlePointerUp = () => {
    setPressed(false)
    if (onSelect && btnRef.current) {
      onSelect(btnRef.current.getBoundingClientRect())
    }
  }

  return (
    <button
      ref={btnRef}
      onPointerDown={() => setPressed(true)}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      className="mode-card"
      style={{
        position: 'relative',
        width: '100%',
        padding: '18px 22px',
        borderRadius: '16px',
        textAlign: 'left',
        cursor: 'pointer',
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
        background: pressed ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255,255,255,0.09)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.06)',
        transform: pressed ? 'scale(0.984) translateY(1px)' : 'scale(1)',
        transition: pressed
          ? 'transform 80ms ease-out, background 60ms ease'
          : 'transform 150ms cubic-bezier(0.34,1.56,0.64,1), background 120ms ease',
      } as CSSProperties}
    >
      <span key={sweepKey} className={sweepKey > 0 ? 'card-sweep' : ''} />
      <div style={{
        position: 'relative', zIndex: 1,
        fontWeight: 700,
        fontSize: 'clamp(0.95rem, 3.5vw, 1.05rem)',
        letterSpacing: '0.14em',
        color: '#fff',
        textTransform: 'uppercase',
        marginBottom: '3px',
        lineHeight: 1.2,
      }}>
        {label}
      </div>
      <div style={{
        position: 'relative', zIndex: 1,
        fontWeight: 300,
        fontStyle: 'italic',
        fontSize: '0.70rem',
        color: 'rgba(255,255,255,0.42)',
        letterSpacing: '0.06em',
        lineHeight: 1.4,
      }}>
        {desc}
      </div>
    </button>
  )
}

// ── Champions Screen ──────────────────────────────────────────────────────────
function ChampionsScreen({
  isExiting,
  origin,
  onBack,
}: {
  isExiting: boolean
  origin: { x: number; y: number }
  onBack: (rect: DOMRect) => void
}) {
  const backBtnRef = useRef<HTMLButtonElement>(null)
  const [backPressed, setBackPressed] = useState(false)

  const handleBack = () => {
    if (backBtnRef.current) onBack(backBtnRef.current.getBoundingClientRect())
  }

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [showScrollHint, setShowScrollHint] = useState(false)
  const maxPower = Math.max(...CHAMPIONS_DATA.map(c => c.power))

  useEffect(() => {
    const id = setTimeout(() => {
      const el = scrollContainerRef.current
      if (!el || el.scrollHeight <= el.clientHeight) return
      setShowScrollHint(true)
      const target = 72
      const duration = 1900
      const start = performance.now()
      const tick = (now: number) => {
        const t = Math.min((now - start) / duration, 1)
        el.scrollTop = target * Math.sin(t * Math.PI)
        if (t < 1) requestAnimationFrame(tick)
        else { el.scrollTop = 0; setTimeout(() => setShowScrollHint(false), 300) }
      }
      requestAnimationFrame(tick)
    }, 1100)
    return () => clearTimeout(id)
  }, [])

  return (
    <div
      className={isExiting ? 'screen-collapse' : 'screen-reveal'}
      style={{
        '--ox': `${origin.x.toFixed(2)}%`,
        '--oy': `${origin.y.toFixed(2)}%`,
        position: 'absolute', inset: 0,
        background: '#0e1d36',
        fontFamily: '"Exo 2", sans-serif',
        zIndex: 20,
        overflow: 'hidden',
      } as CSSProperties}
    >
      <ArenaEnvironment />

      {/* Scrollable content — separated so the finger hint stays fixed */}
      <div ref={scrollContainerRef} className="champions-scroll">
        <div
          className="relative z-10 flex flex-col"
          style={{
            padding: 'env(safe-area-inset-bottom, 20px)',
            paddingLeft: '20px',
            paddingRight: '20px',
            paddingTop: 'calc(env(safe-area-inset-top, 16px) + 68px)',
            boxSizing: 'border-box',
            minHeight: '100%',
          }}
        >
          {/* Top bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
              <img src={appIcon} alt="" style={{ width: '30px', height: '30px', borderRadius: '22%', objectFit: 'cover', boxShadow: '0 2px 8px rgba(0,0,0,0.40)' }} />
              <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'rgba(255,255,255,0.76)', letterSpacing: '0.03em' }}>TeqRallly</span>
            </div>
            <button
              ref={backBtnRef}
              onPointerDown={() => setBackPressed(true)}
              onPointerUp={() => { setBackPressed(false); handleBack() }}
              onPointerLeave={() => setBackPressed(false)}
              onPointerCancel={() => setBackPressed(false)}
              style={{
                background: backPressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
                backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
                border: '1px solid rgba(255,255,255,0.22)', borderRadius: '18px',
                padding: '7px 14px', fontFamily: '"Exo 2", sans-serif', fontWeight: 500,
                fontSize: '0.62rem', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.82)',
                textTransform: 'uppercase', cursor: 'pointer', outline: 'none',
                WebkitTapHighlightColor: 'transparent',
                boxShadow: backPressed ? '0 1px 4px rgba(0,0,0,0.20)' : '0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
                transform: backPressed ? 'scale(0.92)' : 'scale(1)',
                opacity: backPressed ? 0.65 : 1,
                transition: backPressed ? 'transform 80ms ease-out, opacity 80ms ease' : 'transform 130ms ease-out, opacity 130ms ease',
                whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
              }}
            >
              ← BACK
            </button>
          </div>

          {/* Heading */}
          <h1 style={{
            fontWeight: 600, fontSize: 'clamp(1.55rem, 7vw, 2rem)', color: '#ffffff',
            textTransform: 'uppercase', lineHeight: 1.05, margin: '0 0 4px',
            letterSpacing: '0.02em', flexShrink: 0,
          }}>
            Champions
          </h1>
          <p style={{
            fontWeight: 300, fontStyle: 'italic', fontSize: '0.70rem',
            color: 'rgba(255,255,255,0.38)', letterSpacing: '0.06em', margin: '0 0 20px',
          }}>
            Your roster, and what it takes to grow it
          </p>

          {/* Roster cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '48px' }}>
            {CHAMPIONS_DATA.map(champ => (
              <ChampionCard key={champ.id} champ={champ} maxPower={maxPower} />
            ))}
          </div>
        </div>
      </div>

      {/* Scroll hint finger — lives outside the scroll container so it doesn't move */}
      {showScrollHint && (
        <div
          className="scroll-hint-anim"
          style={{
            position: 'absolute',
            bottom: '72px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 30,
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '5px',
          }}
        >
          <svg width="22" height="34" viewBox="0 0 22 34" fill="none">
            <rect x="3" y="0" width="16" height="26" rx="8" fill="rgba(255,255,255,0.78)" />
            <rect x="7" y="2" width="8" height="5" rx="2.5" fill="rgba(255,255,255,0.32)" />
          </svg>
          <div style={{
            width: '1.5px', height: '22px',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.55) 0%, transparent 100%)',
          }} />
        </div>
      )}
    </div>
  )
}

function ChampionCard({ champ, maxPower }: { champ: typeof CHAMPIONS_DATA[0]; maxPower: number }) {
  const [pressed, setPressed] = useState(false)
  const fillPct = (champ.power / maxPower) * 100
  const statEntries = Object.entries(champ.stats)

  return (
    <div
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        position: 'relative',
        borderRadius: '18px',
        padding: '18px 20px 16px',
        background: pressed ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.07)',
        transform: pressed ? 'scale(0.985)' : 'scale(1)',
        transition: pressed ? 'transform 80ms ease-out' : 'transform 150ms cubic-bezier(0.34,1.56,0.64,1)',
        overflow: 'hidden',
        cursor: 'pointer',
      }}
    >
      {/* Faint flag watermark */}
      <span aria-hidden="true" style={{
        position: 'absolute', right: '14px', top: '10px',
        fontSize: '4.5rem', lineHeight: 1, opacity: 0.10,
        pointerEvents: 'none', userSelect: 'none',
      }}>
        {champ.flag}
      </span>

      {/* Name row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '1.25rem', lineHeight: 1 }}>{champ.flag}</span>
          <span style={{ fontWeight: 600, fontSize: 'clamp(1.0rem, 4.5vw, 1.2rem)', letterSpacing: '0.08em', color: '#fff' }}>
            {champ.name}
          </span>
        </div>
        <span style={{
          background: 'rgba(224,117,32,0.18)', border: '1px solid rgba(224,117,32,0.38)',
          borderRadius: '12px', padding: '3px 10px',
          fontWeight: 400, fontSize: '0.58rem', letterSpacing: '0.10em',
          color: '#f08840', textTransform: 'uppercase',
        }}>
          Level {champ.level}
        </span>
      </div>

      {/* Power number */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontWeight: 600, fontSize: '1.45rem', color: '#f08232', lineHeight: 1, letterSpacing: '-0.02em' }}>
          {champ.power}
        </span>
        <span style={{ fontWeight: 300, fontSize: '0.60rem', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.32)', textTransform: 'uppercase' }}>
          total power
        </span>
      </div>

      {/* Power bar */}
      <div style={{
        height: '3px', borderRadius: '2px',
        background: 'rgba(255,255,255,0.07)',
        marginBottom: '16px', overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', borderRadius: '2px',
          width: `${fillPct}%`,
          background: 'linear-gradient(90deg, #cc5a0e 0%, #f08232 60%, #f5b060 100%)',
          boxShadow: '0 0 5px rgba(240,130,50,0.45)',
        }} />
      </div>

      {/* Stats — two-column label / value grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        rowGap: '5px',
        columnGap: '16px',
        marginBottom: '14px',
      }}>
        {statEntries.flatMap(([key, val]) => [
          <span key={`${key}-l`} style={{
            fontWeight: 300, fontSize: '0.63rem', letterSpacing: '0.07em',
            color: 'rgba(255,255,255,0.36)', textTransform: 'uppercase',
          }}>
            {STAT_NAMES[key] ?? key}
          </span>,
          <span key={`${key}-v`} style={{
            fontWeight: 400, fontSize: '0.63rem', letterSpacing: '0.04em',
            color: 'rgba(255,255,255,0.70)', textAlign: 'right',
          }}>
            {val}
          </span>,
        ])}
      </div>

      {/* Status / CTA */}
      {champ.fullyTrained ? (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          fontWeight: 400, fontSize: '0.60rem', letterSpacing: '0.10em',
          color: '#6dd49a', textTransform: 'uppercase',
        }}>
          <span style={{ fontSize: '0.72rem' }}>✓</span> Fully trained
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.63rem', color: 'rgba(255,255,255,0.28)' }}>
            1 more match to next level
          </span>
          <button
            onPointerDown={e => e.stopPropagation()}
            style={{
              background: 'linear-gradient(135deg, #f08232 0%, #cc5a0e 100%)',
              border: 'none', borderRadius: '14px',
              padding: '6px 14px',
              fontFamily: '"Exo 2", sans-serif', fontWeight: 500,
              fontSize: '0.62rem', letterSpacing: '0.08em',
              color: '#fff', textTransform: 'uppercase',
              cursor: 'pointer', outline: 'none',
              boxShadow: '0 4px 14px rgba(224,100,20,0.40)',
              whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
            }}
          >
            🪙 {champ.upgradeCost}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Challenges Screen ─────────────────────────────────────────────────────────
function ChallengesScreen({
  isExiting,
  origin,
  onBack,
}: {
  isExiting: boolean
  origin: { x: number; y: number }
  onBack: (rect: DOMRect) => void
}) {
  const backBtnRef = useRef<HTMLButtonElement>(null)
  const [backPressed, setBackPressed] = useState(false)
  const handleBack = () => { if (backBtnRef.current) onBack(backBtnRef.current.getBoundingClientRect()) }

  return (
    <div
      className={isExiting ? 'screen-collapse' : 'screen-reveal'}
      style={{
        '--ox': `${origin.x.toFixed(2)}%`,
        '--oy': `${origin.y.toFixed(2)}%`,
        position: 'absolute', inset: 0,
        background: '#0e1d36',
        fontFamily: '"Exo 2", sans-serif',
        zIndex: 20,
        overflowY: 'auto',
        scrollbarWidth: 'none' as CSSProperties['scrollbarWidth'],
      } as CSSProperties}
    >
      <ArenaEnvironment />

      <div
        className="relative z-10 flex flex-col"
        style={{
          padding: 'env(safe-area-inset-bottom, 20px)',
          paddingLeft: '20px', paddingRight: '20px',
          paddingTop: 'calc(env(safe-area-inset-top, 16px) + 68px)',
          boxSizing: 'border-box', minHeight: '100%',
        }}
      >
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
            <img src={appIcon} alt="" style={{ width: '30px', height: '30px', borderRadius: '22%', objectFit: 'cover', boxShadow: '0 2px 8px rgba(0,0,0,0.40)' }} />
            <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'rgba(255,255,255,0.76)', letterSpacing: '0.03em' }}>TeqRallly</span>
          </div>
          <button
            ref={backBtnRef}
            onPointerDown={() => setBackPressed(true)}
            onPointerUp={() => { setBackPressed(false); handleBack() }}
            onPointerLeave={() => setBackPressed(false)}
            onPointerCancel={() => setBackPressed(false)}
            style={{
              background: backPressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.22)', borderRadius: '18px',
              padding: '7px 14px', fontFamily: '"Exo 2", sans-serif', fontWeight: 500,
              fontSize: '0.62rem', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.82)',
              textTransform: 'uppercase', cursor: 'pointer', outline: 'none',
              WebkitTapHighlightColor: 'transparent',
              boxShadow: backPressed ? '0 1px 4px rgba(0,0,0,0.20)' : '0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
              transform: backPressed ? 'scale(0.92)' : 'scale(1)',
              opacity: backPressed ? 0.65 : 1,
              transition: backPressed ? 'transform 80ms ease-out, opacity 80ms ease' : 'transform 130ms ease-out, opacity 130ms ease',
              whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
            }}
          >
            ← BACK
          </button>
        </div>

        {/* Heading */}
        <h1 style={{
          fontWeight: 600, fontSize: 'clamp(1.55rem, 7vw, 2rem)', color: '#ffffff',
          textTransform: 'uppercase', lineHeight: 1.05, margin: '0 0 4px', letterSpacing: '0.02em',
        }}>
          Challenges
        </h1>

        {/* Reset timer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '22px' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
          <span style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.68rem', color: 'rgba(255,255,255,0.36)', letterSpacing: '0.04em' }}>
            Resets in 14h 25m
          </span>
        </div>

        {/* Challenge cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '32px' }}>
          {CHALLENGES_DATA.map(ch => (
            <ChallengeCard key={ch.id} challenge={ch} />
          ))}
        </div>
      </div>
    </div>
  )
}

function ChallengeCard({ challenge }: { challenge: typeof CHALLENGES_DATA[0] }) {
  const [pressed, setPressed] = useState(false)
  const pct = challenge.total > 0 ? (challenge.current / challenge.total) * 100 : 0
  const done = challenge.current >= challenge.total

  return (
    <div
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        position: 'relative',
        borderRadius: '16px',
        padding: '16px 20px 14px',
        background: done
          ? 'rgba(109,212,154,0.06)'
          : pressed ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        border: done
          ? '1px solid rgba(109,212,154,0.18)'
          : '1px solid rgba(255,255,255,0.09)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.06)',
        transform: pressed ? 'scale(0.985)' : 'scale(1)',
        transition: pressed ? 'transform 80ms ease-out' : 'transform 150ms cubic-bezier(0.34,1.56,0.64,1)',
        cursor: 'pointer',
      }}
    >
      {/* Label + reward */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{
          fontWeight: 400, fontSize: 'clamp(0.90rem, 3.8vw, 1.05rem)',
          color: done ? 'rgba(255,255,255,0.55)' : '#fff',
          letterSpacing: '0.01em', lineHeight: 1.3,
          textDecoration: done ? 'line-through' : 'none',
        }}>
          {challenge.label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0, marginLeft: '12px' }}>
          <CoinIcon />
          <span style={{
            fontWeight: 600, fontSize: '0.90rem',
            color: done ? 'rgba(245,197,24,0.45)' : '#f5c518',
            letterSpacing: '0.02em',
          }}>
            {challenge.reward}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,0.07)', marginBottom: '8px', overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: '2px',
          width: `${pct}%`,
          background: done
            ? 'linear-gradient(90deg, #3fa870 0%, #6dd49a 100%)'
            : 'linear-gradient(90deg, #cc5a0e 0%, #f08232 60%, #f5b060 100%)',
          boxShadow: done ? '0 0 5px rgba(109,212,154,0.40)' : '0 0 5px rgba(240,130,50,0.45)',
          transition: 'width 600ms cubic-bezier(0.22,1,0.36,1)',
        }} />
      </div>

      {/* Progress label */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontWeight: 300, fontSize: '0.62rem', letterSpacing: '0.06em',
          color: done ? 'rgba(109,212,154,0.60)' : 'rgba(255,255,255,0.30)',
        }}>
          {done ? 'Completed' : `${challenge.current} / ${challenge.total}`}
        </span>
        {done && (
          <span style={{ fontSize: '0.68rem', color: '#6dd49a', fontWeight: 400, letterSpacing: '0.08em' }}>✓</span>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Shared screen primitives
// ══════════════════════════════════════════════════════════════════════════════

type ScreenProps = { isExiting: boolean; origin: { x: number; y: number }; onBack: (rect: DOMRect) => void }

function ScreenWrapper({ isExiting, origin, children }: Omit<ScreenProps, 'onBack'> & { children: ReactNode }) {
  return (
    <div
      className={`no-scrollbar ${isExiting ? 'screen-collapse' : 'screen-reveal'}`}
      style={{
        '--ox': `${origin.x.toFixed(2)}%`,
        '--oy': `${origin.y.toFixed(2)}%`,
        position: 'absolute', inset: 0,
        background: '#0e1d36', fontFamily: '"Exo 2", sans-serif',
        zIndex: 20, overflowY: 'auto',
      } as CSSProperties}
    >
      <ArenaEnvironment />
      <div
        className="relative z-10 flex flex-col"
        style={{
          padding: 'env(safe-area-inset-bottom, 20px)',
          paddingLeft: '20px', paddingRight: '20px',
          paddingTop: 'calc(env(safe-area-inset-top, 16px) + 68px)',
          boxSizing: 'border-box', minHeight: '100%',
        }}
      >
        {children}
      </div>
    </div>
  )
}

function ScreenTopBar({ onBack }: { onBack: (rect: DOMRect) => void }) {
  const [pressed, setPressed] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
        <img src={appIcon} alt="" style={{ width: '30px', height: '30px', borderRadius: '22%', objectFit: 'cover', boxShadow: '0 2px 8px rgba(0,0,0,0.40)' }} />
        <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'rgba(255,255,255,0.76)', letterSpacing: '0.03em' }}>TeqRallly</span>
      </div>
      <button
        ref={btnRef}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => { setPressed(false); if (btnRef.current) onBack(btnRef.current.getBoundingClientRect()) }}
        onPointerLeave={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        style={{
          background: pressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
          backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.22)', borderRadius: '18px',
          padding: '7px 14px', fontFamily: '"Exo 2", sans-serif', fontWeight: 500,
          fontSize: '0.62rem', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.82)',
          textTransform: 'uppercase', cursor: 'pointer', outline: 'none',
          WebkitTapHighlightColor: 'transparent',
          boxShadow: pressed ? '0 1px 4px rgba(0,0,0,0.20)' : '0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
          transform: pressed ? 'scale(0.92)' : 'scale(1)', opacity: pressed ? 0.65 : 1,
          transition: pressed ? 'transform 80ms ease-out, opacity 80ms ease' : 'transform 130ms ease-out, opacity 130ms ease',
          whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
        }}
      >← BACK</button>
    </div>
  )
}

function ScreenHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h1 style={{ fontWeight: 600, fontSize: 'clamp(1.55rem, 7vw, 2rem)', color: '#fff', textTransform: 'uppercase', lineHeight: 1.05, margin: '0 0 4px', letterSpacing: '0.02em' }}>
        {title}
      </h1>
      {subtitle && (
        <p style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.70rem', color: 'rgba(255,255,255,0.38)', letterSpacing: '0.06em', margin: '0 0 20px' }}>
          {subtitle}
        </p>
      )}
      {!subtitle && <div style={{ marginBottom: '22px' }} />}
    </>
  )
}

function SettingRow({ title, desc, action, warning }: { title: string; desc?: string; action: ReactNode; warning?: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
      padding: '16px 20px', borderRadius: '16px',
      background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
      border: '1px solid rgba(255,255,255,0.09)',
      boxShadow: '0 4px 20px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.06)',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: '0.90rem', color: '#fff', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: (desc || warning) ? '3px' : 0 }}>{title}</div>
        {desc && <div style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.65rem', color: 'rgba(255,255,255,0.38)', letterSpacing: '0.04em' }}>{desc}</div>}
        {warning && <div style={{ fontWeight: 500, fontSize: '0.63rem', color: '#f5c518', letterSpacing: '0.04em', marginTop: '3px' }}>{warning}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{action}</div>
    </div>
  )
}

function PillButton({ label, onClick }: { label: string; onClick?: () => void }) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => { setPressed(false); onClick?.() }}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        background: pressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.22)', borderRadius: '20px',
        padding: '9px 16px', fontFamily: '"Exo 2", sans-serif', fontWeight: 500,
        fontSize: '0.60rem', letterSpacing: '0.10em', color: 'rgba(255,255,255,0.85)',
        textTransform: 'uppercase', cursor: 'pointer', outline: 'none',
        WebkitTapHighlightColor: 'transparent', whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
        boxShadow: pressed ? '0 1px 4px rgba(0,0,0,0.20)' : '0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
        transform: pressed ? 'scale(0.92)' : 'scale(1)',
        transition: pressed ? 'transform 80ms ease-out' : 'transform 130ms cubic-bezier(0.34,1.56,0.64,1)',
      }}
    >{label}</button>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        width: '50px', height: '28px', borderRadius: '14px', position: 'relative',
        background: on ? 'linear-gradient(135deg, #f08232 0%, #cc5a0e 100%)' : 'rgba(255,255,255,0.14)',
        border: 'none', cursor: 'pointer', outline: 'none',
        WebkitTapHighlightColor: 'transparent',
        boxShadow: on ? '0 2px 10px rgba(240,130,50,0.45)' : 'none',
        transition: 'background 220ms ease, box-shadow 220ms ease',
        flexShrink: 0,
      }}
    >
      <div style={{
        position: 'absolute', top: '3px',
        left: on ? '23px' : '3px',
        width: '22px', height: '22px', borderRadius: '11px',
        background: '#fff', boxShadow: '0 1px 5px rgba(0,0,0,0.30)',
        transition: 'left 200ms cubic-bezier(0.34,1.56,0.64,1)',
      }} />
    </button>
  )
}

function SegmentedControl({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{
      display: 'flex', borderRadius: '12px',
      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
      padding: '3px', gap: '3px',
    }}>
      {options.map(opt => {
        const active = value === opt
        return (
          <button key={opt} onClick={() => onChange(opt)} style={{
            flex: 1, padding: '9px 4px', borderRadius: '9px',
            border: 'none', cursor: 'pointer', outline: 'none',
            background: active ? 'linear-gradient(135deg, #f08232 0%, #cc5a0e 100%)' : 'transparent',
            color: active ? '#fff' : 'rgba(255,255,255,0.40)',
            fontFamily: '"Exo 2", sans-serif', fontWeight: active ? 600 : 400,
            fontSize: '0.60rem', letterSpacing: '0.08em', textTransform: 'uppercase',
            boxShadow: active ? '0 2px 8px rgba(240,130,50,0.40)' : 'none',
            transition: 'all 150ms ease',
            WebkitTapHighlightColor: 'transparent',
          }}>{opt}</button>
        )
      })}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Supplies Screen
// ══════════════════════════════════════════════════════════════════════════════

const SUPPLIES_DATA = [
  { id: 'coins',    name: '328 Coins',         desc: 'Legs: 100% of normal',                                                        action: 'Get Coins', warning: null,               cost: null },
  { id: 'isotonic', name: 'Isotonic',           desc: 'Salts back in. You will still be running in the third set.  ·  1 in the bag', action: 'Use Next',  warning: null,               cost: null },
  { id: 'espresso', name: 'Double Espresso',    desc: 'Not sensible. Very effective — fresher legs and a sharper first step.',        action: 'Buy',       warning: 'Not enough coins', cost: 420  },
  { id: 'recovery', name: 'Recovery Protocol',  desc: 'Sleep, food and physio, on a schedule. Taken once, kept for good.',            action: 'Take',      warning: 'Not enough coins', cost: 2200 },
]

function SuppliesScreen({ isExiting, origin, onBack }: ScreenProps) {
  return (
    <ScreenWrapper isExiting={isExiting} origin={origin}>
      <ScreenTopBar onBack={onBack} />
      <ScreenHeading title="Supplies" subtitle="What you've got, and what you can get" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '32px' }}>
        {SUPPLIES_DATA.map(item => (
          <SettingRow
            key={item.id}
            title={item.name}
            desc={`${item.desc}${item.cost ? `  ·  ${item.cost} coins` : ''}`}
            warning={item.warning ?? undefined}
            action={<PillButton label={item.action} />}
          />
        ))}
      </div>
    </ScreenWrapper>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Profile Screen
// ══════════════════════════════════════════════════════════════════════════════

function ProfileScreen({ isExiting, origin, onBack }: ScreenProps) {
  const [name, setName] = useState('')
  const [createPressed, setCreatePressed] = useState(false)
  const [restorePressed, setRestorePressed] = useState(false)

  return (
    <ScreenWrapper isExiting={isExiting} origin={origin}>
      <ScreenTopBar onBack={onBack} />
      <ScreenHeading title="Your Profile" />
      <div style={{
        borderRadius: '20px', padding: '22px 20px',
        background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(255,255,255,0.09)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.07)',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', color: '#fff', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
            Play under your own name
          </div>
          <div style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.68rem', color: 'rgba(255,255,255,0.45)', letterSpacing: '0.03em', lineHeight: 1.6 }}>
            A name on the leaderboard, trophies that follow you to your next phone, and an opponent who knows who they just played.
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 400, fontSize: '0.60rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' }}>
            Your name
          </div>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder=""
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '13px 16px', borderRadius: '12px',
              background: 'rgba(255,255,255,0.05)',
              border: '1.5px solid rgba(240,130,50,0.55)',
              outline: 'none', color: '#fff',
              fontFamily: '"Exo 2", sans-serif', fontWeight: 400, fontSize: '0.95rem',
              letterSpacing: '0.04em',
            }}
          />
        </div>

        <div style={{
          padding: '12px 16px', borderRadius: '12px',
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
          fontWeight: 300, fontStyle: 'italic', fontSize: '0.65rem',
          color: 'rgba(255,255,255,0.40)', lineHeight: 1.6, letterSpacing: '0.02em',
        }}>
          A new profile starts from zero. The 442 trophies you have played for stay on this device, but they will not be on the leaderboard.
        </div>

        <button
          onPointerDown={() => setCreatePressed(true)}
          onPointerUp={() => setCreatePressed(false)}
          onPointerLeave={() => setCreatePressed(false)}
          onPointerCancel={() => setCreatePressed(false)}
          style={{
            width: '100%', padding: '16px',
            borderRadius: '14px', border: 'none', cursor: 'pointer', outline: 'none',
            WebkitTapHighlightColor: 'transparent',
            background: createPressed
              ? 'linear-gradient(152deg, #f09848 0%, #d06518 55%, #ae4e10 100%)'
              : 'linear-gradient(152deg, #f08232 0%, #cc6014 55%, #a84c0e 100%)',
            boxShadow: createPressed
              ? '0 3px 14px rgba(224,100,20,0.50)'
              : '0 8px 28px rgba(224,100,20,0.48), inset 0 1px 0 rgba(255,195,90,0.35)',
            transform: createPressed ? 'scale(0.97)' : 'scale(1)',
            transition: createPressed ? 'transform 80ms ease-out' : 'transform 150ms cubic-bezier(0.34,1.56,0.64,1)',
            fontFamily: '"Exo 2", sans-serif', fontWeight: 700,
            fontSize: '0.80rem', letterSpacing: '0.22em', color: '#fff', textTransform: 'uppercase',
          }}
        >
          Create Profile
        </button>

        <button
          onPointerDown={() => setRestorePressed(true)}
          onPointerUp={() => setRestorePressed(false)}
          onPointerLeave={() => setRestorePressed(false)}
          onPointerCancel={() => setRestorePressed(false)}
          style={{
            width: '100%', padding: '14px',
            borderRadius: '14px', cursor: 'pointer', outline: 'none',
            WebkitTapHighlightColor: 'transparent',
            background: restorePressed ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.14)',
            boxShadow: restorePressed ? 'none' : 'inset 0 1px 0 rgba(255,255,255,0.12)',
            transform: restorePressed ? 'scale(0.97)' : 'scale(1)',
            transition: restorePressed ? 'transform 80ms ease-out' : 'transform 150ms cubic-bezier(0.34,1.56,0.64,1)',
            fontFamily: '"Exo 2", sans-serif', fontWeight: 500,
            fontSize: '0.72rem', letterSpacing: '0.16em', color: 'rgba(255,255,255,0.60)', textTransform: 'uppercase',
          }}
        >
          Restore a Profile
        </button>

        <div style={{
          padding: '10px 14px', borderRadius: '10px',
          background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
          fontWeight: 300, fontStyle: 'italic', fontSize: '0.62rem',
          color: 'rgba(255,255,255,0.32)', lineHeight: 1.6, letterSpacing: '0.02em',
        }}>
          The profile lives on this device. There is no password to recover it, so keep your code somewhere safe.
        </div>
      </div>
    </ScreenWrapper>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Settings Screen (submenu) + sub-screens
// ══════════════════════════════════════════════════════════════════════════════

function SettingsNavRow({ title, desc, onTap }: { title: string; desc: string; onTap: (rect: DOMRect) => void }) {
  const [pressed, setPressed] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => { setPressed(false); if (ref.current) onTap(ref.current.getBoundingClientRect()) }}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
        width: '100%', textAlign: 'left',
        padding: '18px 20px', borderRadius: '16px',
        background: pressed ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)',
        backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(255,255,255,0.09)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.06)',
        transform: pressed ? 'scale(0.985)' : 'scale(1)',
        transition: pressed ? 'transform 80ms ease-out' : 'transform 150ms cubic-bezier(0.34,1.56,0.64,1)',
        cursor: 'pointer', outline: 'none', WebkitTapHighlightColor: 'transparent',
      }}
    >
      <div>
        <div style={{ fontWeight: 500, fontSize: '0.90rem', color: '#fff', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>{title}</div>
        <div style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.65rem', color: 'rgba(255,255,255,0.38)', letterSpacing: '0.03em' }}>{desc}</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  )
}

function SettingsScreen({ isExiting, origin, onBack, onDisplay, onAudio, onGameplay, onKit }: ScreenProps & { onDisplay: NavHandler; onAudio: NavHandler; onGameplay: NavHandler; onKit: NavHandler }) {
  return (
    <ScreenWrapper isExiting={isExiting} origin={origin}>
      <ScreenTopBar onBack={onBack} />
      <ScreenHeading title="Settings" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '32px' }}>
        <SettingsNavRow title="Display"  desc="Graphics, camera and language"        onTap={onDisplay}  />
        <SettingsNavRow title="Gameplay" desc="How much the game helps you"           onTap={onGameplay} />
        <SettingsNavRow title="Audio"    desc="Music and sound effects"               onTap={onAudio}    />
        <SettingsNavRow title="Your Kit" desc="The name and number on your shirt"     onTap={onKit}      />
      </div>
    </ScreenWrapper>
  )
}

const LANGUAGES = ['English', 'Français', 'Español', 'Português', '日本語', '中文', 'हिन्दी']

function DisplayScreen({ isExiting, origin, onBack }: ScreenProps) {
  const [graphics, setGraphics] = useState('HIGH')
  const [camera,   setCamera]   = useState('COURT')
  const [language, setLanguage] = useState('English')

  return (
    <ScreenWrapper isExiting={isExiting} origin={origin}>
      <ScreenTopBar onBack={onBack} />
      <ScreenHeading title="Display" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '32px' }}>

        {/* Graphics — 2-option segmented on the right */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
          padding: '16px 20px', borderRadius: '16px',
          background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
          border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, fontSize: '0.90rem', color: '#fff', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Graphics</div>
            <div style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.65rem', color: 'rgba(255,255,255,0.38)', letterSpacing: '0.04em', marginBottom: '4px' }}>Detail against framerate</div>
            <div style={{ fontWeight: 500, fontSize: '0.63rem', color: '#f5c518', letterSpacing: '0.04em' }}>Changing this restarts the game.</div>
          </div>
          <SegmentedControl options={['MEDIUM', 'HIGH']} value={graphics} onChange={setGraphics} />
        </div>

        {/* Camera — 2-option segmented on the right */}
        <SettingRow
          title="Camera"
          desc="The view a match opens in"
          action={<SegmentedControl options={['COURT', 'SIDE']} value={camera} onChange={setCamera} />}
        />

        {/* Language — full-width card with horizontal scroll pills */}
        <div style={{
          padding: '16px 20px', borderRadius: '16px',
          background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
          border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          <div style={{ fontWeight: 500, fontSize: '0.90rem', color: '#fff', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Language</div>
          <div style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.65rem', color: 'rgba(255,255,255,0.38)', letterSpacing: '0.04em', marginBottom: '12px' }}>Menus and on-screen text</div>
          <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: '2px' }}>
            {LANGUAGES.map(lang => {
              const active = language === lang
              return (
                <button key={lang} onClick={() => setLanguage(lang)} style={{
                  flexShrink: 0, padding: '8px 14px', borderRadius: '20px', border: 'none',
                  background: active ? 'linear-gradient(135deg, #f08232 0%, #cc5a0e 100%)' : 'rgba(255,255,255,0.07)',
                  color: active ? '#fff' : 'rgba(255,255,255,0.45)',
                  fontFamily: '"Exo 2", sans-serif', fontWeight: active ? 600 : 400,
                  fontSize: '0.72rem', letterSpacing: '0.04em',
                  boxShadow: active ? '0 2px 10px rgba(240,130,50,0.40)' : 'none',
                  cursor: 'pointer', outline: 'none', WebkitTapHighlightColor: 'transparent',
                  transition: 'all 150ms ease',
                }}>
                  {lang}
                </button>
              )
            })}
          </div>
        </div>

      </div>
    </ScreenWrapper>
  )
}

function AudioScreen({ isExiting, origin, onBack }: ScreenProps) {
  const [music, setMusic] = useState(true)
  const [sfx, setSfx]     = useState(true)
  return (
    <ScreenWrapper isExiting={isExiting} origin={origin}>
      <ScreenTopBar onBack={onBack} />
      <ScreenHeading title="Audio" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SettingRow title="Music"         desc="Menu and match loops"          action={<Toggle on={music} onChange={setMusic} />} />
        <SettingRow title="Sound Effects" desc="Kicks, bounces and the crowd"  action={<Toggle on={sfx}   onChange={setSfx}   />} />
      </div>
    </ScreenWrapper>
  )
}

function GameplayScreen({ isExiting, origin, onBack }: ScreenProps) {
  const [autoRecep, setAutoRecep] = useState(true)
  return (
    <ScreenWrapper isExiting={isExiting} origin={origin}>
      <ScreenTopBar onBack={onBack} />
      <ScreenHeading title="Gameplay" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SettingRow title="Automatic Reception" desc="Standing near the ball takes the first touch for you" action={<Toggle on={autoRecep} onChange={setAutoRecep} />} />
      </div>
    </ScreenWrapper>
  )
}

function KitScreen({ isExiting, origin, onBack }: ScreenProps) {
  const [crest, setCrest] = useState('DISC')
  return (
    <ScreenWrapper isExiting={isExiting} origin={origin}>
      <ScreenTopBar onBack={onBack} />
      <ScreenHeading title="Your Kit" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '32px' }}>
        <SettingRow title="Name on the shirt" desc="BIEBIE" action={<PillButton label="Edit" />} />
        <SettingRow title="Squad Number"      desc="10"     action={<PillButton label="Edit" />} />
        <div style={{
          padding: '16px 20px', borderRadius: '16px',
          background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
          border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          <div style={{ fontWeight: 500, fontSize: '0.90rem', color: '#fff', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Crest</div>
          <div style={{ fontWeight: 300, fontStyle: 'italic', fontSize: '0.65rem', color: 'rgba(255,255,255,0.38)', letterSpacing: '0.03em', marginBottom: '10px' }}>A small badge on the chest</div>
          <SegmentedControl options={['NONE', 'SHIELD', 'DISC', 'STAR']} value={crest} onChange={setCrest} />
        </div>
      </div>
    </ScreenWrapper>
  )
}

// ── Difficulty Screen ─────────────────────────────────────────────────────────
function DifficultyScreen({
  isExiting,
  isBackground = false,
  origin,
  onBack,
  onDifficultySelect,
}: {
  isExiting: boolean
  isBackground?: boolean
  origin: { x: number; y: number }
  onBack: (rect: DOMRect) => void
  onDifficultySelect: (difficulty: string, rect: DOMRect) => void
}) {
  const hasRevealedRef = useRef(false)
  const animClass = isBackground
    ? ''
    : isExiting
      ? 'screen-collapse'
      : hasRevealedRef.current ? '' : 'screen-reveal'
  if (!isBackground && !isExiting) hasRevealedRef.current = true

  const backBtnRef = useRef<HTMLButtonElement>(null)
  const [backPressed, setBackPressed] = useState(false)

  const handleBack = () => {
    if (backBtnRef.current) onBack(backBtnRef.current.getBoundingClientRect())
  }

  return (
    <div
      className={animClass}
      style={{
        '--ox': `${origin.x.toFixed(2)}%`,
        '--oy': `${origin.y.toFixed(2)}%`,
        position: 'absolute', inset: 0,
        background: '#0e1d36',
        fontFamily: '"Exo 2", sans-serif',
        zIndex: 21,
        overflowY: 'auto',
        ...(isBackground ? { clipPath: 'circle(150% at 50% 50%)' } : {}),
      } as CSSProperties}
    >
      <ArenaEnvironment />
      <div
        className="relative z-10 flex flex-col"
        style={{
          padding: 'env(safe-area-inset-bottom, 20px)',
          paddingLeft: '20px',
          paddingRight: '20px',
          paddingTop: 'calc(env(safe-area-inset-top, 16px) + 68px)',
          boxSizing: 'border-box',
          height: '100%',
        }}
      >
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
            <img src={appIcon} alt="" style={{ width: '30px', height: '30px', borderRadius: '22%', objectFit: 'cover', boxShadow: '0 2px 8px rgba(0,0,0,0.40)' }} />
            <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'rgba(255,255,255,0.76)', letterSpacing: '0.03em' }}>TeqRallly</span>
          </div>
          <button
            ref={backBtnRef}
            onPointerDown={() => setBackPressed(true)}
            onPointerUp={() => { setBackPressed(false); handleBack() }}
            onPointerLeave={() => setBackPressed(false)}
            onPointerCancel={() => setBackPressed(false)}
            style={{
              background: backPressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.22)', borderRadius: '18px',
              padding: '7px 14px', fontFamily: '"Exo 2", sans-serif', fontWeight: 600,
              fontSize: '0.62rem', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.82)',
              textTransform: 'uppercase', cursor: 'pointer', outline: 'none',
              WebkitTapHighlightColor: 'transparent', whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
              boxShadow: backPressed ? '0 1px 4px rgba(0,0,0,0.20)' : '0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
              transform: backPressed ? 'scale(0.92)' : 'scale(1)',
              transition: backPressed ? 'transform 80ms ease-out, opacity 80ms ease' : 'transform 130ms ease-out, opacity 130ms ease',
            }}
          >
            ← BACK
          </button>
        </div>

        {/* Heading */}
        <h1 style={{ fontFamily: '"Exo 2", sans-serif', fontWeight: 900, fontSize: 'clamp(1.55rem, 7vw, 2rem)', color: '#ffffff', textTransform: 'uppercase', lineHeight: 1.05, margin: '0 0 6px', letterSpacing: '-0.01em', flexShrink: 0 }}>
          Difficulty
        </h1>
        <p style={{ fontWeight: 300, fontSize: '0.72rem', color: 'rgba(255,255,255,0.46)', letterSpacing: '0.04em', marginBottom: '28px', flexShrink: 0 }}>
          How hard should the CPU make you work?
        </p>

        {/* Difficulty cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {DIFFICULTIES.map((d) => (
            <DifficultyCard
              key={d.id}
              id={d.id}
              label={d.label}
              desc={d.desc}
              recommended={d.recommended}
              onSelect={(rect) => onDifficultySelect(d.id, rect)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function DifficultyCard({
  label,
  desc,
  recommended,
  onSelect,
}: {
  id: string
  label: string
  desc: string
  recommended: boolean
  onSelect: (rect: DOMRect) => void
}) {
  const [pressed, setPressed] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const handleUp = () => {
    setPressed(false)
    if (btnRef.current) onSelect(btnRef.current.getBoundingClientRect())
  }

  const bg = recommended
    ? pressed ? 'linear-gradient(135deg, #d97020 0%, #b84e0c 100%)' : 'linear-gradient(135deg, #f08232 0%, #cc5a0e 100%)'
    : pressed ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)'

  return (
    <button
      ref={btnRef}
      onPointerDown={() => setPressed(true)}
      onPointerUp={handleUp}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        width: '100%',
        padding: recommended ? '20px 22px' : '17px 22px',
        borderRadius: '16px',
        textAlign: 'left',
        cursor: 'pointer',
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
        background: bg,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: recommended ? '1px solid rgba(255,170,80,0.40)' : '1px solid rgba(255,255,255,0.09)',
        boxShadow: recommended
          ? '0 6px 28px rgba(240,130,50,0.35), inset 0 1px 0 rgba(255,200,100,0.22)'
          : '0 2px 12px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.06)',
        transform: pressed ? 'scale(0.984) translateY(1px)' : 'scale(1)',
        transition: pressed
          ? 'transform 80ms ease-out, background 60ms ease'
          : 'transform 150ms cubic-bezier(0.34,1.56,0.64,1), background 120ms ease',
      } as CSSProperties}
    >
      <div style={{
        fontWeight: 800,
        fontSize: 'clamp(0.95rem, 3.5vw, 1.05rem)',
        letterSpacing: '0.14em',
        color: '#fff',
        textTransform: 'uppercase',
        marginBottom: '3px',
        lineHeight: 1.2,
      }}>{label}</div>
      <div style={{
        fontWeight: 300,
        fontStyle: 'italic',
        fontSize: '0.70rem',
        color: recommended ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.42)',
        letterSpacing: '0.06em',
        lineHeight: 1.4,
      }}>{desc}</div>
    </button>
  )
}

// ── Setup Screen ──────────────────────────────────────────────────────────────
function SetupScreen({
  isExiting,
  origin,
  onBack,
  mode,
  difficulty,
}: {
  isExiting: boolean
  origin: { x: number; y: number }
  onBack: (rect: DOMRect) => void
  mode: string
  difficulty: string
}) {
  const backBtnRef = useRef<HTMLButtonElement>(null)
  const [backPressed, setBackPressed] = useState(false)
  const [tab, setTab] = useState<'player' | 'ball' | 'venue'>('player')
  const [playerIdx, setPlayerIdx] = useState(0)
  const [ballIdx, setBallIdx] = useState(0)
  const [venueIdx, setVenueIdx] = useState(0)
  const [playPressed, setPlayPressed] = useState(false)

  const handleBack = () => {
    if (backBtnRef.current) onBack(backBtnRef.current.getBoundingClientRect())
  }

  const player = PLAYERS_DATA[playerIdx]
  const ball = BALLS_DATA[ballIdx]
  const venue = VENUES_DATA[venueIdx]

  const currentName = tab === 'player' ? player.name : tab === 'ball' ? ball.name : venue.name
  const currentTotal = tab === 'player' ? PLAYERS_DATA.length : tab === 'ball' ? BALLS_DATA.length : VENUES_DATA.length
  const currentIdx = tab === 'player' ? playerIdx : tab === 'ball' ? ballIdx : venueIdx
  const setCurrentIdx = tab === 'player' ? setPlayerIdx : tab === 'ball' ? setBallIdx : setVenueIdx

  const prev = () => setCurrentIdx((i) => (i - 1 + currentTotal) % currentTotal)
  const next = () => setCurrentIdx((i) => (i + 1) % currentTotal)

  const STAT_KEYS = ['REACT', 'PWR', 'CTRL', 'AGIL', 'VOL', 'SERVE', 'STAM'] as const

  return (
    <div
      className={isExiting ? 'screen-collapse' : 'screen-reveal'}
      style={{
        '--ox': `${origin.x.toFixed(2)}%`,
        '--oy': `${origin.y.toFixed(2)}%`,
        position: 'absolute', inset: 0,
        background: '#070b14',
        fontFamily: '"Exo 2", sans-serif',
        zIndex: 22,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      } as CSSProperties}
    >
      {/* Subtle arena ambience */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at 50% 0%, rgba(20,60,160,0.22) 0%, transparent 65%)',
      }} />

      {/* Top bar */}
      <div style={{
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'calc(env(safe-area-inset-top, 16px) + 16px) 20px 0',
        position: 'relative', zIndex: 2,
      }}>
        <button
          ref={backBtnRef}
          onPointerDown={() => setBackPressed(true)}
          onPointerUp={() => { setBackPressed(false); handleBack() }}
          onPointerLeave={() => setBackPressed(false)}
          onPointerCancel={() => setBackPressed(false)}
          style={{
            background: backPressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
            backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.22)', borderRadius: '18px',
            padding: '7px 14px', fontFamily: '"Exo 2", sans-serif', fontWeight: 600,
            fontSize: '0.62rem', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.82)',
            textTransform: 'uppercase', cursor: 'pointer', outline: 'none',
            WebkitTapHighlightColor: 'transparent',
            boxShadow: backPressed ? '0 1px 4px rgba(0,0,0,0.20)' : '0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
            transform: backPressed ? 'scale(0.92)' : 'scale(1)',
            transition: backPressed ? 'transform 80ms ease-out' : 'transform 130ms ease-out',
          }}
        >
          ← BACK
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: 300, fontSize: '0.62rem', color: 'rgba(255,255,255,0.40)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            {mode} · {difficulty}
          </span>
          <img src={appIcon} alt="" style={{ width: '26px', height: '26px', borderRadius: '22%', objectFit: 'cover', opacity: 0.8 }} />
        </div>
      </div>

      {/* Heading */}
      <div style={{ flexShrink: 0, padding: '12px 20px 0', position: 'relative', zIndex: 2 }}>
        <h1 style={{ fontFamily: '"Exo 2", sans-serif', fontWeight: 900, fontSize: 'clamp(1.2rem, 5.5vw, 1.6rem)', color: '#ffffff', textTransform: 'uppercase', lineHeight: 1.05, margin: '0 0 14px', letterSpacing: '-0.01em' }}>
          Choose your setup
        </h1>

        {/* Tab strip */}
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['player', 'ball', 'venue'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: '9px 0',
                borderRadius: '10px',
                border: tab === t ? '1px solid rgba(255,160,60,0.50)' : '1px solid rgba(255,255,255,0.10)',
                background: tab === t
                  ? 'linear-gradient(135deg, #f08232 0%, #cc5a0e 100%)'
                  : 'rgba(255,255,255,0.05)',
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                fontFamily: '"Exo 2", sans-serif',
                fontWeight: 700,
                fontSize: '0.60rem',
                letterSpacing: '0.12em',
                color: tab === t ? '#fff' : 'rgba(255,255,255,0.45)',
                textTransform: 'uppercase',
                cursor: 'pointer',
                outline: 'none',
                WebkitTapHighlightColor: 'transparent',
                boxShadow: tab === t ? '0 4px 16px rgba(240,130,50,0.30)' : 'none',
                transition: 'all 180ms ease',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Viewport */}
      <div style={{
        flex: 1,
        position: 'relative',
        margin: '12px 20px 0',
        borderRadius: '18px',
        overflow: 'hidden',
        background: '#0a0f1e',
        border: '1px solid rgba(255,255,255,0.07)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '0',
      }}>
        {tab === 'player' && <PlayerViewport player={player} />}
        {tab === 'ball' && <BallViewport ball={ball} />}
        {tab === 'venue' && <VenueViewport venue={venue} />}
      </div>

      {/* Stats panel — only for player and ball */}
      {tab !== 'venue' && (
        <div style={{
          flexShrink: 0,
          margin: '10px 20px 0',
          padding: '12px 16px',
          borderRadius: '14px',
          background: 'rgba(255,255,255,0.04)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          border: '1px solid rgba(255,255,255,0.08)',
          position: 'relative', zIndex: 2,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 14px' }}>
            {STAT_KEYS.map((key) => {
              const base = player.stats[key]
              const mod = tab === 'ball' ? (ball.statMod[key] ?? 0) : 0
              const val = base + mod
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontWeight: 300, fontSize: '0.56rem', color: 'rgba(255,255,255,0.40)', letterSpacing: '0.08em', textTransform: 'uppercase', width: '52px', flexShrink: 0 }}>
                    {STAT_NAMES[key]}
                  </span>
                  <div style={{ flex: 1, height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,0.10)', overflow: 'hidden' }}>
                    <div style={{ width: `${val}%`, height: '100%', borderRadius: '2px', background: mod > 0 ? '#4ccc7a' : mod < 0 ? '#e85858' : 'linear-gradient(90deg, #f08232, #e04010)', transition: 'width 300ms ease' }} />
                  </div>
                  <span style={{ fontWeight: 700, fontSize: '0.60rem', color: '#fff', width: '20px', textAlign: 'right', flexShrink: 0 }}>{val}</span>
                  {tab === 'ball' && mod !== 0 && (
                    <span style={{ fontWeight: 600, fontSize: '0.55rem', color: mod > 0 ? '#4ccc7a' : '#e85858', width: '20px', flexShrink: 0 }}>
                      {mod > 0 ? `+${mod}` : `${mod}`}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          {tab === 'player' && (
            <div style={{ display: 'flex', gap: '20px', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
              <span style={{ fontWeight: 300, fontSize: '0.56rem', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Strong Foot · <span style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>{player.foot}</span>
              </span>
              <span style={{ fontWeight: 300, fontSize: '0.56rem', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Height · <span style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>{player.height}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Navigation row + PLAY */}
      <div style={{
        flexShrink: 0,
        padding: '12px 20px calc(env(safe-area-inset-bottom, 20px) + 12px)',
        position: 'relative', zIndex: 2,
        display: 'flex', flexDirection: 'column', gap: '10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '18px' }}>
          <NavArrow dir="prev" onPress={prev} />
          <span style={{ fontWeight: 800, fontSize: '0.85rem', letterSpacing: '0.14em', color: '#fff', textTransform: 'uppercase', flex: '0 0 auto', minWidth: '120px', textAlign: 'center' }}>
            {currentName}
          </span>
          <NavArrow dir="next" onPress={next} />
        </div>
        <button
          onPointerDown={() => setPlayPressed(true)}
          onPointerUp={() => setPlayPressed(false)}
          onPointerLeave={() => setPlayPressed(false)}
          onPointerCancel={() => setPlayPressed(false)}
          style={{
            width: '100%',
            padding: '16px',
            borderRadius: '16px',
            background: playPressed
              ? 'linear-gradient(135deg, #d97020 0%, #b84e0c 100%)'
              : 'linear-gradient(135deg, #f08232 0%, #cc5a0e 100%)',
            border: '1px solid rgba(255,160,60,0.35)',
            fontFamily: '"Exo 2", sans-serif',
            fontWeight: 900,
            fontSize: '1rem',
            letterSpacing: '0.14em',
            color: '#fff',
            textTransform: 'uppercase',
            cursor: 'pointer',
            outline: 'none',
            WebkitTapHighlightColor: 'transparent',
            boxShadow: playPressed
              ? '0 4px 16px rgba(240,130,50,0.30)'
              : '0 8px 32px rgba(240,130,50,0.45), inset 0 1px 0 rgba(255,200,100,0.28)',
            transform: playPressed ? 'scale(0.975) translateY(1px)' : 'scale(1)',
            transition: playPressed ? 'transform 80ms ease-out' : 'transform 200ms cubic-bezier(0.34,1.56,0.64,1)',
          }}
        >
          PLAY
        </button>
      </div>
    </div>
  )
}

function NavArrow({ dir, onPress }: { dir: 'prev' | 'next'; onPress: () => void }) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      onPointerDown={() => { setPressed(true); onPress() }}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      style={{
        width: '42px', height: '42px', borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: pressed ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.15)',
        boxShadow: pressed ? 'none' : '0 3px 12px rgba(0,0,0,0.30)',
        cursor: 'pointer', outline: 'none', WebkitTapHighlightColor: 'transparent',
        transform: pressed ? 'scale(0.88)' : 'scale(1)',
        transition: pressed ? 'transform 60ms ease-out' : 'transform 130ms cubic-bezier(0.34,1.56,0.64,1)',
        fontSize: '1rem', color: 'rgba(255,255,255,0.75)',
      }}
    >
      {dir === 'prev' ? '‹' : '›'}
    </button>
  )
}

function PlayerViewport({ player }: { player: typeof PLAYERS_DATA[number] }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      {/* Team color glow */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 55%, ${player.color}44 0%, transparent 68%)`,
        pointerEvents: 'none',
      }} />
      {/* Ground ellipse */}
      <div style={{
        position: 'absolute', bottom: '12%', left: '50%', transform: 'translateX(-50%)',
        width: '55%', height: '18px', borderRadius: '50%',
        background: `radial-gradient(ellipse, ${player.color}30 0%, transparent 70%)`,
      }} />
      {/* Player flag — large */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: 'clamp(72px, 18vw, 110px)', lineHeight: 1, filter: `drop-shadow(0 12px 32px ${player.color}80)` }}>
          {player.flag}
        </span>
        <div style={{
          paddingInline: '14px', paddingBlock: '5px',
          borderRadius: '8px',
          background: `${player.color}33`,
          border: `1px solid ${player.color}66`,
          fontWeight: 700, fontSize: '0.62rem', letterSpacing: '0.16em',
          color: 'rgba(255,255,255,0.85)', textTransform: 'uppercase',
        }}>
          #10
        </div>
      </div>
    </div>
  )
}

function BallViewport({ ball }: { ball: typeof BALLS_DATA[number] }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      {/* Ball glow */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 50%, ${ball.color}22 0%, transparent 65%)`,
        pointerEvents: 'none',
      }} />
      {/* Ground shadow */}
      <div style={{
        position: 'absolute', bottom: '16%', left: '50%', transform: 'translateX(-50%)',
        width: '40%', height: '14px', borderRadius: '50%',
        background: 'radial-gradient(ellipse, rgba(0,0,0,0.45) 0%, transparent 70%)',
      }} />
      {/* CSS sphere */}
      <div style={{
        width: 'clamp(110px, 26vw, 160px)',
        height: 'clamp(110px, 26vw, 160px)',
        borderRadius: '50%',
        background: `radial-gradient(circle at 38% 35%, ${ball.color}ff 0%, ${ball.color}cc 30%, ${ball.color2} 72%, #010307 100%)`,
        boxShadow: `0 0 0 1px ${ball.color}44, 0 18px 40px rgba(0,0,0,0.65), inset -14px -14px 28px rgba(0,0,0,0.42), inset 6px 6px 14px rgba(255,255,255,0.08)`,
        position: 'relative', zIndex: 1,
      }}>
        {/* Pentagon-style patches */}
        <div style={{
          position: 'absolute', top: '28%', left: '28%', width: '44%', height: '44%',
          borderRadius: '30%',
          background: `rgba(0,0,0,0.18)`,
          border: `1.5px solid rgba(0,0,0,0.22)`,
        }} />
      </div>
    </div>
  )
}

function VenueViewport({ venue }: { venue: typeof VENUES_DATA[number] }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', perspective: '600px' }}>
      {/* Ambient glow */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 40%, ${venue.color}44 0%, transparent 65%)`,
        pointerEvents: 'none',
      }} />
      {/* Court in perspective */}
      <div style={{
        transform: 'rotateX(42deg)',
        transformStyle: 'preserve-3d',
        width: 'clamp(220px, 65vw, 300px)',
        aspectRatio: '1.8',
        background: venue.color,
        borderRadius: '6px',
        border: `3px solid ${venue.lineColor}`,
        position: 'relative',
        boxShadow: `0 24px 60px rgba(0,0,0,0.70), 0 0 0 1px rgba(255,255,255,0.05)`,
      }}>
        {/* Center line (horizontal) */}
        <div style={{ position: 'absolute', top: '50%', left: '5%', right: '5%', height: '2px', background: venue.lineColor, transform: 'translateY(-50%)' }} />
        {/* Net / half-divider */}
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: '3px', background: venue.lineColor, transform: 'translateX(-50%)' }} />
        {/* Service boxes */}
        <div style={{ position: 'absolute', top: '25%', left: '5%', right: '55%', bottom: '25%', border: `1.5px solid ${venue.lineColor}`, borderRadius: '2px' }} />
        <div style={{ position: 'absolute', top: '25%', left: '55%', right: '5%', bottom: '25%', border: `1.5px solid ${venue.lineColor}`, borderRadius: '2px' }} />
      </div>
    </div>
  )
}
