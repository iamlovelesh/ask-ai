import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { THEME, FONT_STACK } from '../theme';

/** Full-frame intro/outro card. */
export const TitleCard: React.FC<{ title: string; subtitle: string; durationInFrames: number; kicker?: string }> = ({
  title,
  subtitle,
  durationInFrames,
  kicker,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inP = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 24 });
  const y = interpolate(inP, [0, 1], [24, 0]);
  const outP = interpolate(frame, [durationInFrames - 14, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 700px at 50% 38%, ${THEME.bg1}, ${THEME.bg0})`,
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <div style={{ opacity: Math.min(inP, outP), transform: `translateY(${y}px)`, padding: '0 160px' }}>
        {kicker ? (
          <div style={{ color: THEME.accent, font: `600 26px ${FONT_STACK}`, letterSpacing: '0.18em', marginBottom: 24, textTransform: 'uppercase' }}>
            {kicker}
          </div>
        ) : null}
        <div
          style={{
            font: `700 110px ${FONT_STACK}`,
            letterSpacing: '-0.03em',
            background: `linear-gradient(120deg, ${THEME.ink}, ${THEME.accent} 55%, ${THEME.accent2})`,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            lineHeight: 1,
          }}
        >
          {title}
        </div>
        <div style={{ marginTop: 28, color: THEME.sub, font: `400 36px ${FONT_STACK}`, lineHeight: 1.3 }}>{subtitle}</div>
      </div>
    </AbsoluteFill>
  );
};
