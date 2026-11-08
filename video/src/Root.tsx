import { Composition } from 'remotion';
import { Demo } from './Demo';
import { THEME } from './theme';
import { FPS, totalFrames } from './timeline';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Demo"
      component={Demo}
      durationInFrames={Math.max(60, totalFrames())}
      fps={FPS}
      width={THEME.width}
      height={THEME.height}
    />
  );
};
