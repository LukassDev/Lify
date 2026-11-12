import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type ImageSourcePropType, type StyleProp, type ImageStyle } from 'react-native';
import { Image, type ImageErrorEventData } from 'expo-image';
import { artworkSources, rememberArtworkSource } from '@/services/artwork';
import { Icon, type IconName } from './Icon';

interface ArtworkImageProps {
  uri?: string | null;
  source?: ImageSourcePropType;
  style?: StyleProp<ImageStyle>;
  placeholderIcon?: IconName;
  onError?: (event: ImageErrorEventData) => void;
}

export const ArtworkImage = memo(function ArtworkImage(props: ArtworkImageProps) {
  // Uma nova capa recebe estado próprio, mesmo quando a lista recicla a linha.
  const identity = `${props.uri ?? ''}:${JSON.stringify(props.source ?? null)}`;
  return <ArtworkContent key={identity} {...props} />;
});

function ArtworkContent({ uri, source, style, placeholderIcon = 'musical-notes', onError }: ArtworkImageProps) {
  const sources = useMemo(() => artworkSources(uri), [uri]);
  const [candidate, setCandidate] = useState(0);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [frameAspect, setFrameAspect] = useState(1);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const imageUri = source ? undefined : sources[candidate];
  // Estas miniaturas são 4:3, com o vídeo 16:9 dentro de faixas pretas.
  // O contentFit="cover" sozinho ainda deixa essas faixas nas capas quadradas.
  const letterboxed = !!imageUri && /^https?:\/\/(?:i\d?\.ytimg\.com|img\.youtube\.com)\/vi(?:_webp)?\/[^/]+\/(?:hqdefault|sddefault|default|[0-3])\.[a-z]+(?:[?#]|$)/i.test(imageUri);
  const imageScale = letterboxed
    ? (Math.max(frameAspect, 16 / 9) / Math.max(frameAspect, 4 / 3)) * 1.02
    : 1.06;
  const requestKey = `${imageUri ?? 'local'}:${retry}`;
  const currentRequest = useRef(requestKey);
  currentRequest.current = requestKey;
  const dimensions = StyleSheet.flatten(style);
  const size = typeof dimensions?.width === 'number' ? dimensions.width : 80;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  return (
    <View
      style={[s.frame, style]}
      onLayout={({ nativeEvent: { layout } }) => {
        if (layout.width > 0 && layout.height > 0) setFrameAspect(layout.width / layout.height);
      }}
    >
      {!loaded ? <Icon name={placeholderIcon} size={Math.max(16, Math.min(44, size * 0.38))} color="rgba(255,255,255,0.5)" /> : null}
      {source || imageUri ? (
        <Image
          key={requestKey}
          source={source ?? { uri: imageUri }}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={imageUri ?? JSON.stringify(source)}
          transition={0}
          style={[s.image, { transform: [{ scale: imageScale }] }]}
          onLoad={() => {
            if (!mounted.current || currentRequest.current !== requestKey) return;
            if (retryTimer.current) clearTimeout(retryTimer.current);
            setLoaded(true);
            if (uri && imageUri) rememberArtworkSource(uri, imageUri);
          }}
          onError={(event) => {
            if (!mounted.current || currentRequest.current !== requestKey) return;
            setLoaded(false);
            if (!source && candidate + 1 < sources.length) {
              setCandidate(candidate + 1);
            } else if (retry < 2) {
              if (retryTimer.current) clearTimeout(retryTimer.current);
              retryTimer.current = setTimeout(() => {
                if (!mounted.current) return;
                setCandidate(0);
                setRetry(retry + 1);
              }, 1500 * (retry + 1));
            } else {
              onError?.(event);
            }
          }}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  frame: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  image: { ...StyleSheet.absoluteFill, width: '100%', height: '100%' },
});
