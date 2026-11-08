import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { THEME, FONT_STACK } from '../theme';

/** Full-width caption bar pinned to the bottom, below the app frame. */
export const LowerThird: React.FC<{
  chip: string;
  title: string;
  subtitle?: string;
  durationInFrames: number;
}> = ({ chip, title, subtitle, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const inP = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  const x = interpolate(inP, [0, 1], [-40, 0]);
  const outStart = durationInFrames - 14;
  const outP = interpolate(frame, [outStart, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const opacity = Math.min(inP, outP);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 180,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 110px',
        background:
          'linear-gradient(180deg, rgba(8,16,20,0) 0%, rgba(8,16,20,0.80) 34%, rgba(8,16,20,0.97) 100%)',
      }}
    >
      <div style={{ transform: `translateX(${x}px)`, opacity }}>
        <div
          style={{
            display: 'inline-block',
            padding: '5px 13px',
            borderRadius: 999,
            background: 'rgba(45,212,191,0.16)',
            border: '1px solid rgba(45,212,191,0.5)',
            color: THEME.accent,
            font: `600 19px ${FONT_STACK}`,
            marginBottom: 11,
          }}
        >
          {chip}
        </div>
        <div style={{ color: THEME.ink, font: `700 44px ${FONT_STACK}`, letterSpacing: '-0.02em', lineHeight: 1.05 }}>{title}</div>
        {subtitle ? <div style={{ marginTop: 7, color: THEME.sub, font: `400 24px ${FONT_STACK}` }}>{subtitle}</div> : null}
      </div>
    </div>
  );
};
