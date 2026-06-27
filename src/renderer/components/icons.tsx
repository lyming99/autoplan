import * as React from 'react';

const overviewIcon = (
  <>
    <rect x="3.5" y="4" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="4" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="14" width="7" height="6" rx="1.6" />
    <path d="M14 17h6" />
    <path d="M17 14v6" />
  </>
);

const requirementIcon = (
  <>
    <path d="M6.5 3.5h7.8L18 7.2v13.3H6.5z" />
    <path d="M14 3.8v3.7h3.7" />
    <path d="M9 11h6" />
    <path d="M9 15h6" />
    <path d="M9 18h3.5" />
  </>
);

const feedbackIcon = (
  <>
    <path d="M5 5.5h14v9.2H9.7L6.2 18v-3.3H5z" />
    <path d="M8.5 9.2h7" />
    <path d="M8.5 12h4.8" />
  </>
);

const taskIcon = (
  <>
    <path d="M8 6h12" />
    <path d="M8 12h12" />
    <path d="M8 18h12" />
    <path d="m3.8 6 1.1 1.1L7 4.9" />
    <path d="m3.8 12 1.1 1.1L7 10.9" />
    <path d="m3.8 18 1.1 1.1L7 16.9" />
  </>
);

const eventIcon = (
  <>
    <path d="M4 12h3l2-5 4 10 2-5h5" />
    <circle cx="4" cy="12" r="1.4" />
    <circle cx="20" cy="12" r="1.4" />
  </>
);

const planIcon = (
  <>
    <rect x="4" y="5" width="16" height="15" rx="2" />
    <path d="M8 3.5v3" />
    <path d="M16 3.5v3" />
    <path d="M4 9h16" />
    <path d="M8 13h3" />
    <path d="M13.5 13H16" />
    <path d="M8 16.5h5" />
  </>
);

const runIcon = (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m10.2 8.7 5.1 3.3-5.1 3.3z" />
  </>
);

const stopIcon = (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
  </>
);

const completeIcon = (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.2 12.2 2.4 2.4 5.2-5.2" />
  </>
);

const editIcon = (
  <>
    <path d="M4.5 19.5h4.2L19 9.2 14.8 5 4.5 15.3z" />
    <path d="m13.6 6.2 4.2 4.2" />
  </>
);

const deleteIcon = (
  <>
    <path d="M5 7h14" />
    <path d="M9 7V5h6v2" />
    <path d="M7 7.5 8 20h8l1-12.5" />
    <path d="M10.2 11v5" />
    <path d="M13.8 11v5" />
  </>
);

const warningIcon = (
  <>
    <path d="M10.4 4.5 3.6 17.2A1.8 1.8 0 0 0 5.2 20h13.6a1.8 1.8 0 0 0 1.6-2.8L13.6 4.5a1.8 1.8 0 0 0-3.2 0z" />
    <path d="M12 9v4.5" />
    <path d="M12 17h.01" />
  </>
);

const refreshIcon = (
  <>
    <path d="M20 6v5h-5" />
    <path d="M4 18v-5h5" />
    <path d="M18.2 10A6.5 6.5 0 0 0 7 6.4L4 9" />
    <path d="M5.8 14A6.5 6.5 0 0 0 17 17.6l3-2.6" />
  </>
);

const attachmentIcon = (
  <>
    <path d="m8.6 12.5 5.8-5.8a3 3 0 0 1 4.2 4.2l-7.2 7.2a4.2 4.2 0 0 1-6-6l7.1-7.1" />
    <path d="m10.8 14.7 5.6-5.6" />
  </>
);

const sendIcon = (
  <>
    <path d="M20 4 9.5 14.5" />
    <path d="m20 4-5.6 16-4.9-5.5L4 12z" />
  </>
);

const plusIcon = (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8v8" />
    <path d="M8 12h8" />
  </>
);

const closeIcon = (
  <>
    <path d="M7 7 17 17" />
    <path d="M17 7 7 17" />
  </>
);

const searchIcon = (
  <>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 4.5 4.5" />
  </>
);

const enterIcon = (
  <>
    <path d="M4.5 12h10" />
    <path d="m11 8 4 4-4 4" />
    <path d="M14.5 5H19v14h-4.5" />
  </>
);

const backIcon = (
  <>
    <path d="M19.5 12h-15" />
    <path d="m9 7-5 5 5 5" />
  </>
);

const settingsIcon = (
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </>
);

const cliIcon = (
  <>
    <rect x="4.5" y="5.5" width="15" height="13" rx="2" />
    <path d="m8 10 2.4 2L8 14" />
    <path d="M12.5 14h3.5" />
  </>
);

const thinkingIcon = (
  <>
    <path d="M9 18h6" />
    <path d="M10 21h4" />
    <path d="M8.2 14.2a6 6 0 1 1 7.6 0c-.8.6-1.2 1.3-1.3 2.3h-5c-.1-1-.5-1.7-1.3-2.3z" />
    <path d="M12 8.5v3" />
    <path d="M10.5 10h3" />
  </>
);

const helpIcon = (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.8 9.4a2.3 2.3 0 0 1 4.4 1c0 1.7-2.2 1.9-2.2 3.6" />
    <path d="M12 17h.01" />
  </>
);

const fileIcon = (
  <>
    <path d="M6.5 3.5h8L18 7v13.5H6.5z" />
    <path d="M14.2 3.8v3.5h3.5" />
  </>
);

const folderIcon = (
  <>
    <path d="M4 7.5h6l1.8 2H20v8.8a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 18.3z" />
    <path d="M4 9.5V6.7A2.2 2.2 0 0 1 6.2 4.5h3.1l1.8 2H18a2 2 0 0 1 2 2v1" />
  </>
);

const plugIcon = (
  <>
    <path d="M9 7V3.8" />
    <path d="M15 7V3.8" />
    <path d="M7 7h10v4.5a5 5 0 0 1-10 0z" />
    <path d="M12 16.5v3.7" />
  </>
);

const saveIcon = (
  <>
    <path d="M5 4.5h12.2L20 7.3v12.2H5z" />
    <path d="M8 4.8v5h7v-5" />
    <path d="M8 19.2v-5.5h8v5.5" />
  </>
);

const ICONS = {
  overview: overviewIcon,
  requirement: requirementIcon,
  requirements: requirementIcon,
  feedback: feedbackIcon,
  task: taskIcon,
  tasks: taskIcon,
  event: eventIcon,
  events: eventIcon,
  plan: planIcon,
  plans: planIcon,
  run: runIcon,
  running: runIcon,
  stop: stopIcon,
  stopped: stopIcon,
  complete: completeIcon,
  completed: completeIcon,
  edit: editIcon,
  delete: deleteIcon,
  trash: deleteIcon,
  warning: warningIcon,
  alert: warningIcon,
  refresh: refreshIcon,
  attachment: attachmentIcon,
  attachments: attachmentIcon,
  send: sendIcon,
  plus: plusIcon,
  close: closeIcon,
  search: searchIcon,
  enter: enterIcon,
  open: enterIcon,
  back: backIcon,
  settings: settingsIcon,
  cli: cliIcon,
  terminal: cliIcon,
  code: cliIcon,
  thinking: thinkingIcon,
  help: helpIcon,
  file: fileIcon,
  folder: folderIcon,
  plug: plugIcon,
  mcp: plugIcon,
  save: saveIcon,
  check: completeIcon,
} as const;

export type IconName = keyof typeof ICONS;

export const iconNames = Object.freeze(Object.keys(ICONS) as IconName[]);

type IconSize = number | string;

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'children' | 'height' | 'viewBox' | 'width'> {
  name: IconName;
  size?: IconSize;
  title?: string;
}

function isAriaHidden(value: IconProps['aria-hidden']) {
  return value === true || value === 'true';
}

function formatIconSize(size: IconSize) {
  return typeof size === 'number' ? `${size}px` : size;
}

export function Icon({
  name,
  size = 20,
  title,
  className,
  style,
  role,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
  ...svgProps
}: IconProps) {
  const titleId = React.useId();
  const hasAccessibleName = Boolean(title || ariaLabel);
  const shouldHide = ariaHidden === undefined ? !hasAccessibleName : isAriaHidden(ariaHidden);
  const labelledBy = title && !shouldHide ? titleId : undefined;
  const iconStyle = {
    '--icon-size': formatIconSize(size),
    ...style,
  } as React.CSSProperties;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...svgProps}
      className={['app-icon', className].filter(Boolean).join(' ')}
      style={iconStyle}
      aria-hidden={shouldHide ? true : undefined}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      role={role ?? (!shouldHide && hasAccessibleName ? 'img' : undefined)}
    >
      {labelledBy ? <title id={labelledBy}>{title}</title> : null}
      {ICONS[name]}
    </svg>
  );
}
