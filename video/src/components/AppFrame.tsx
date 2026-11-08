import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame, interpolate } from 'remotion';
import { THEME, FONT_STACK } from '../theme';

// The captured app clips are 1440×900. Sized so the whole frame (incl. the
// chrome bar) sits in the top region and never collides with the caption bar.
const FRAME_W = 1380;
const VIDEO_H = Math.round((FRAME_W * 900) / 1440); // preserve 1440×900 aspect

/** A rounded "browser" frame holding one captured app clip. The clip plays its
 * "thinking" portion sped up, then the final answer at 1× so it stays readable. */
export const AppFrame: React.FC<{ src: string; speed: number; part1: number; thinkRawFrames: number; label?: string }> = ({
  src,
  speed,
  part1,
  thinkRawFrames,
  label,
}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 14], [0.99, 1], { extrapolateRight: 'clamp' });
  const fade = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  const vid = { width: '100%', height: '100%', objectFit: 'cover' } as const;

  return (
    <AbsoluteFill style={{ justifyContent: 'flex-start', alignItems: 'center', paddingTop: 40 }}>
      <div
        style={{
          width: FRAME_W,
          transform: `scale(${enter})`,
          opacity: fade,
          borderRadius: 16,
          overflow: 'hidden',
          background: '#0b171c',
          boxShadow: '0 40px 110px rgba(0,0,0,0.55), 0 0 0 1px rgba(45,212,191,0.10)',
        }}
      >
        <div
          style={{
            height: 38,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 16px',
            background: 'linear-gradient(180deg,#12242b,#0d1c22)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <Dot c="#ff5f57" />
          <Dot c="#febc2e" />
          <Dot c="#28c840" />
          <div style={{ flex: 1, textAlign: 'center', color: THEME.sub, font: `500 14px ${FONT_STACK}`, letterSpacing: '-0.01em' }}>
            {label ?? 'Ask AI — localhost'}
          </div>
          <div style={{ width: 54 }} />
        </div>
        <div style={{ position: 'relative', width: '100%', height: VIDEO_H }}>
          {/* 1) sped-up "thinking" */}
          <Sequence durationInFrames={Math.max(1, part1)} layout="none">
            <OffthreadVideo src={staticFile(src)} playbackRate={speed} style={vid} />
          </Sequence>
          {/* 2) the final answer, 1× from where the think portion ended */}
          <Sequence from={part1} layout="none">
            <OffthreadVideo src={staticFile(src)} playbackRate={1} trimBefore={thinkRawFrames} style={vid} />
          </Sequence>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Dot: React.FC<{ c: string }> = ({ c }) => (
  <div style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />
);
