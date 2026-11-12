import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useProgress } from '@/services/audio/useProgress';
import { activeLyricsLine, type Lyrics } from '@/services/lyrics';
import { loadTrackLyrics } from '@/services/trackLyrics';
import type { Track } from '@/types';
import { t, useTranslation } from '@/i18n';
import { colors, font, spacing } from '@/theme/tokens';
import { BottomSheet } from './Overlays';
import { SheetHeader } from './overlay/SheetHeader';
import { Button } from './Button';

export function LyricsModal({ track, duration, onClose }: { track: Track; duration: number; onClose: () => void }) {
  useTranslation();
  const { height } = useWindowDimensions();
  const { position } = useProgress(200);
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; lyrics: Lyrics | null }>({ status: 'loading', lyrics: null });
  const [attempt, setAttempt] = useState(0);
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef<Record<number, number>>({});
  const viewport = useRef(0);
  const title = track.title;
  const artist = track.artist;

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', lyrics: null });
    offsets.current = {};
    scroll.current?.scrollTo({ y: 0, animated: false });
    loadTrackLyrics(track, duration, controller.signal).then((lyrics) => {
      if (!controller.signal.aborted) setState({ status: 'ready', lyrics });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error', lyrics: null });
    });
    return () => controller.abort();
  }, [title, artist, duration, attempt]);

  const lyrics = state.lyrics;
  const active = lyrics?.kind === 'synced' ? activeLyricsLine(lyrics.lines, position) : -1;
  const follow = () => {
    const y = offsets.current[active];
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - viewport.current / 3), animated: true });
  };
  useEffect(follow, [active, lyrics]);

  return (
    <BottomSheet visible onClose={onClose} contentStyle={{ height: Math.min(height * 0.8, 700) }}>
      <SheetHeader title={t('player.lyrics.title')} subtitle={`${track.title} · ${track.artist}`} onClose={onClose} />
      {state.status === 'loading' ? (
        <View style={s.message}><ActivityIndicator color={colors.accent} /><Text style={s.muted}>{t('player.lyrics.loading')}</Text></View>
      ) : state.status === 'error' ? (
        <View style={s.message}><Text style={s.muted}>{t('player.lyrics.error')}</Text><Button label={t('common.retry')} variant="secondary" onPress={() => setAttempt((value) => value + 1)} /></View>
      ) : !lyrics ? (
        <View style={s.message}><Text style={s.muted}>{t('player.lyrics.unavailable')}</Text></View>
      ) : (
        <>
          <Text style={s.muted}>{t(lyrics.kind === 'synced' ? 'player.lyrics.synced' : 'player.lyrics.plain')}</Text>
          <ScrollView ref={scroll} style={s.scroll} contentContainerStyle={s.content}
            onLayout={(event) => { viewport.current = event.nativeEvent.layout.height; follow(); }}
            onContentSizeChange={follow}>
            {lyrics.kind === 'plain' ? <Text selectable style={s.plain}>{lyrics.text}</Text> : lyrics.lines.map((line, index) => (
              <Text key={index} selectable onLayout={(event) => { offsets.current[index] = event.nativeEvent.layout.y; if (index === active) follow(); }}
                style={[s.line, index === active && s.active]}>{line.text || '♪'}</Text>
            ))}
          </ScrollView>
          <Text style={s.credit}>{t('player.lyrics.source')}</Text>
        </>
      )}
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  muted: { color: colors.textMuted, fontSize: font.md, textAlign: 'center' },
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingVertical: spacing.lg, gap: spacing.lg },
  plain: { color: colors.text, fontSize: font.lg, lineHeight: 28 },
  line: { color: colors.textMuted, fontSize: font.xl, fontWeight: '700', lineHeight: 32 },
  active: { color: colors.accent },
  credit: { color: colors.textMuted, fontSize: font.xs, textAlign: 'center' },
});
