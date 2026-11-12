import { useEffect, useState } from 'react';
import { getWebAudioElement } from './controller.web';

export function useProgress(interval = 1000): { position: number; duration: number } {
  const [progress, setProgress] = useState({ position: 0, duration: 0 });
  useEffect(() => {
    let attachedAudio: HTMLAudioElement | null = null;
    const detach = () => {
      attachedAudio?.removeEventListener('timeupdate', update);
      attachedAudio?.removeEventListener('loadedmetadata', update);
    };
    const update = () => {
      const audio = getWebAudioElement();
      if (audio !== attachedAudio) {
        detach();
        attachedAudio = audio;
        audio.addEventListener('timeupdate', update);
        audio.addEventListener('loadedmetadata', update);
      }
      setProgress({
        position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      });
    };
    update();
    const timer = window.setInterval(update, interval);
    return () => {
      detach();
      window.clearInterval(timer);
    };
  }, [interval]);
  return progress;
}
