const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.35,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function IconSidebar() {
  return (
    <svg {...iconProps}>
      <rect x="2.25" y="2.5" width="11.5" height="11" rx="1.25" />
      <path d="M6.5 2.5v11" />
    </svg>
  )
}

export function IconFolder() {
  return (
    <svg {...iconProps}>
      <path d="M2.5 4.75h4.1l1.2 1.35H13.5v6.4a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9V4.75z" />
      <path d="M2.5 4.75V3.9A.9.9 0 0 1 3.4 3h2.55l.7.9" />
    </svg>
  )
}

export function IconPlus() {
  return (
    <svg {...iconProps}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

export function IconSave() {
  return (
    <svg {...iconProps}>
      <path d="M3.25 3.25h8.1L12.75 4.7v8.05H3.25V3.25z" />
      <path d="M5.25 3.25v3.1h5.1V3.25M5.25 12.75v-3.4h5.5v3.4" />
    </svg>
  )
}

export function IconSun() {
  return (
    <svg {...iconProps}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 2.4v1.3M8 12.3v1.3M2.4 8h1.3M12.3 8h1.3M3.95 3.95l.92.92M11.13 11.13l.92.92M12.05 3.95l-.92.92M4.87 11.13l-.92.92" />
    </svg>
  )
}

export function IconMoon() {
  return (
    <svg {...iconProps}>
      <path d="M12.4 9.35A4.85 4.85 0 0 1 6.65 3.6 4.9 4.9 0 1 0 12.4 9.35z" />
    </svg>
  )
}

export function IconMonitor() {
  return (
    <svg {...iconProps}>
      <rect x="2.25" y="3" width="11.5" height="7.5" rx="1.1" />
      <path d="M6.25 13h3.5M8 10.5V13" />
    </svg>
  )
}

export function IconFile() {
  return (
    <svg {...iconProps}>
      <path d="M4.5 2.75h4.2L11.5 5.55v7.7H4.5V2.75z" />
      <path d="M8.6 2.75v2.9h2.9" />
    </svg>
  )
}

export function IconNewFile() {
  return (
    <svg {...iconProps}>
      <path d="M3.75 2.75h3.7L10.25 5.6V8" />
      <path d="M7.35 2.75v2.95h2.9M3.75 2.75v10.5h4.1" />
      <path d="M11.25 9.25v5M8.75 11.75h5" />
    </svg>
  )
}

export function IconNewFolder() {
  return (
    <svg {...iconProps}>
      <path d="M2.5 5h3.7l1.1 1.2H10" />
      <path d="M2.5 5V4.1A.85.85 0 0 1 3.35 3.25h2.2l.65.85" />
      <path d="M2.5 5v6.85A.9.9 0 0 0 3.4 12.75h4.35" />
      <path d="M11.25 9.25v5M8.75 11.75h5" />
    </svg>
  )
}
