import { useState } from 'react';

// Right-hand panel on the Printer Detail page for Klipper printers running the
// paxx12 Snapmaker U1 Extended Firmware. It embeds two pages the printer's own
// nginx already serves on port 80:
//   /webcam/webrtc  camera-streamer style WebRTC player (redirects to /webcam/player
//                   when the camera is set to iframe/H264 mode)
//   /filament/      Filament Manager UI (firmware v1.5.2-paxx12-21 or newer)
//   /screen/        Remote Screen: mirror of the printer touchscreen with touch
//                   control (must be enabled in firmware-config, Web section)
// The frames load straight from the printer, so the browser viewing this page
// must be able to reach the printer IP over plain HTTP. Changes made inside the
// filament frame go directly to the printer's Moonraker; this app does not see
// or store them.

// Printer IPs are stored bare, but tolerate a scheme, port, or trailing slash
// the way the Klipper driver does. The web UI always lives on port 80.
function printerHost(ip) {
  return (ip || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

const cardStyle = {
  background: '#131720', border: '1px solid #1e2433',
  borderRadius: 8, overflow: 'hidden',
};

const cardHeaderStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 14px', borderBottom: '1px solid #1e2433',
};

const cardTitleStyle = {
  fontSize: 13, fontWeight: 600, color: '#64748b',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

const smallButtonStyle = {
  background: 'none', border: '1px solid #2d3748',
  color: '#94a3b8', borderRadius: 5,
  padding: '3px 10px', fontSize: 11, fontWeight: 600,
  cursor: 'pointer', letterSpacing: '0.04em',
  textDecoration: 'none', whiteSpace: 'nowrap',
};

function EmbedCard({ title, src, frameStyle, extra }) {
  // Bumping the key remounts the iframe, which is the only reliable way to
  // reload a cross-origin frame.
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>
        <span style={cardTitleStyle}>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {extra}
          <button type="button" onClick={() => setReloadKey(k => k + 1)} style={smallButtonStyle}>
            Reload
          </button>
          <a href={src} target="_blank" rel="noreferrer" style={smallButtonStyle}>
            Open
          </a>
        </span>
      </div>
      <iframe
        key={reloadKey}
        src={src}
        title={title}
        style={{ display: 'block', width: '100%', border: 'none', background: '#0a0f1a', ...frameStyle }}
      />
    </div>
  );
}

export default function PrinterWebPanel({ ip }) {
  const host = printerHost(ip);
  const [camera, setCamera] = useState('webcam');

  if (!host) {
    return (
      <div style={{ ...cardStyle, padding: '14px 18px', fontSize: 13, color: '#64748b' }}>
        Set this printer's IP address to show its camera and filament panels.
      </div>
    );
  }

  const base = `http://${host}`;

  // A USB camera, when enabled in firmware-config, is served at /webcam2/.
  const cameraToggle = (
    <button
      type="button"
      onClick={() => setCamera(c => (c === 'webcam' ? 'webcam2' : 'webcam'))}
      title="Switch between the internal camera and a USB camera"
      style={smallButtonStyle}
    >
      {camera === 'webcam' ? 'Internal' : 'USB'}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <EmbedCard
        title="Camera"
        src={`${base}/${camera}/webrtc`}
        frameStyle={{ aspectRatio: '16 / 9' }}
        extra={cameraToggle}
      />
      <EmbedCard
        title="Filament"
        src={`${base}/filament/`}
        frameStyle={{ height: 640 }}
      />
      {/* The touchscreen is 800x480; the page scales the image to fit and maps
          clicks back to screen coordinates, so a matching aspect ratio avoids
          letterboxing. Clicks here press buttons on the real printer. */}
      <EmbedCard
        title="Screen"
        src={`${base}/screen/`}
        frameStyle={{ aspectRatio: '5 / 3' }}
      />
    </div>
  );
}
