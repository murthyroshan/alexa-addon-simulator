import { type ReactNode, useEffect, useRef, useState } from 'react';

// Echo devices with a screen, in the CSS pixels a card is laid out in (approximate; the hardware
// scales them). Echo Show 15 also hangs in portrait.
export const DEVICES = {
  show5: { label: 'Echo Show 5', short: 'Show 5', width: 960, height: 480 },
  show8: { label: 'Echo Show 8', short: 'Show 8', width: 1280, height: 800 },
  show10: { label: 'Echo Show 10', short: 'Show 10', width: 1280, height: 800 },
  show15: { label: 'Echo Show 15', short: 'Show 15', width: 1280, height: 720 },
  show15p: { label: 'Echo Show 15 (portrait)', short: 'Show 15 ↕', width: 720, height: 1280 },
  show21: { label: 'Echo Show 21', short: 'Show 21', width: 1920, height: 1080 },
  hub: { label: 'Echo Hub', short: 'Hub', width: 1280, height: 800 },
} as const;
export type DeviceKey = keyof typeof DEVICES;

export type Light = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * The device: a screen laid out at its own resolution, scaled to the space it has. The light bar
 * along the bottom of the screen shows what Alexa is doing. "From across the room" draws it as it
 * looks from about three metres.
 */
export function Device({ width, height, light, far, children }: { width: number; height: number; light: Light; far: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setSpace({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bezel = 30;
  const fitScale = Math.min((space.w - bezel) / width, (space.h - bezel) / height, 1);
  // Three metres away a 15" screen looks about a third of its size at arm's length.
  const scale = Math.max(0.05, far ? fitScale * 0.42 : fitScale);
  return (
    <div className={`device-box ${far ? 'far' : ''}`} ref={box}>
      <div className="bezel" style={{ width: width * scale + bezel, height: height * scale + bezel }}>
        <i className="camera" aria-hidden="true" />
        <div className="screen" style={{ width, height, transform: `scale(${scale})` }}>
          {children}
          <i className={`lightbar ${light}`} aria-hidden="true" />
        </div>
      </div>
      {far && <p className="far-note">As it looks from about 3 metres. Can you still read it?</p>}
    </div>
  );
}
