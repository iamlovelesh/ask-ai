import { AbsoluteFill, Audio, staticFile, Sequence } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { THEME } from './theme';
import { AppFrame } from './components/AppFrame';
import { LowerThird } from './components/LowerThird';
import { TitleCard } from './components/TitleCard';
import { manifest, segments, introFrames, outroFrames, TRANSITION, clipFrames, clipLayout } from './timeline';

const Background: React.FC = () => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(1400px 800px at 50% 0%, ${THEME.bg1}, ${THEME.bg0})`,
    }}
  />
);

export const Demo: React.FC = () => {
  const segs = segments();
  return (
    <AbsoluteFill style={{ background: THEME.bg0 }}>
      <TransitionSeries>
        {segs.map((s, i) => {
          const el =
            s.kind === 'intro' ? (
              <TitleCard kicker="Ask AI" title={manifest.intro.title} subtitle={manifest.intro.subtitle} durationInFrames={introFrames} />
            ) : s.kind === 'outro' ? (
              <TitleCard kicker="Results" title={manifest.outro.title} subtitle={manifest.outro.subtitle} durationInFrames={outroFrames} />
            ) : (
              <AbsoluteFill>
                <Background />
                {(() => {
                  const L = clipLayout(s.clip!);
                  return <AppFrame src={s.clip!.video} speed={L.speed} part1={L.part1} thinkRawFrames={L.thinkRawFrames} />;
                })()}
                <LowerThird chip={s.clip!.chip} title={s.clip!.title} subtitle={s.clip!.subtitle} durationInFrames={clipFrames(s.clip!)} />
              </AbsoluteFill>
            );

          const narrationSrc =
            s.kind === 'clip' ? s.clip!.audio : null;

          return (
            <TransitionSeries.Sequence key={i} durationInFrames={s.frames}>
              <AbsoluteFill>
                {el}
                {/* narration — clips use their captured audio file; intro/outro
                    pull from public/audio/intro.wav|outro.wav if present */}
                <Narration src={narrationSrc ?? (s.kind === 'intro' ? 'audio/intro.wav' : 'audio/outro.wav')} />
              </AbsoluteFill>
            </TransitionSeries.Sequence>
          );
        }).flatMap((seq, i, arr) =>
          i < arr.length - 1
            ? [seq, <TransitionSeries.Transition key={`t${i}`} presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION })} />]
            : [seq],
        )}
      </TransitionSeries>
    </AbsoluteFill>
  );
};

/** Narration audio that silently no-ops if the file isn't there yet (studio
 * preview before the narrate step runs). */
const Narration: React.FC<{ src: string }> = ({ src }) => {
  try {
    return (
      <Sequence from={Math.round(0.5 * (manifest.fps || 30))}>
        <Audio src={staticFile(src)} />
      </Sequence>
    );
  } catch {
    return null;
  }
};
