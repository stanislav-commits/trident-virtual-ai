import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeChatVoice } from "../api/chatVoiceApi";

export type VoiceCaptureStatus =
  | "idle"
  | "requestingPermission"
  | "recording"
  | "stopping"
  | "transcribing"
  | "error"
  | "unsupported";

interface VoiceCaptureSessionOptions {
  value: string;
  onChange: (value: string) => void;
  token: string | null;
  sessionId?: string | null;
}

const MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

const MIN_RECORDING_MS = 300;
const DURATION_TICK_MS = 250;
const MICROPHONE_OPEN_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 5000;

function isAudioCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

function chooseSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }

  return MIME_TYPE_CANDIDATES.find((mimeType) => {
    try {
      return MediaRecorder.isTypeSupported(mimeType);
    } catch {
      return false;
    }
  });
}

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function appendTranscript(baseValue: string, transcript: string): string {
  const normalizedTranscript = normalizeTranscript(transcript);

  if (!normalizedTranscript) {
    return baseValue;
  }

  const normalizedBase = baseValue.trimEnd();
  return normalizedBase
    ? `${normalizedBase} ${normalizedTranscript}`
    : normalizedTranscript;
}

function getFileExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();

  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  return "webm";
}

function getPermissionErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission was denied.";
      case "NotFoundError":
        return "No microphone was found.";
      case "NotReadableError":
        return "The microphone is already in use or unavailable.";
      case "AbortError":
        return "Microphone capture was interrupted.";
      default:
        return error.message || "Microphone access failed.";
    }
  }

  return error instanceof Error ? error.message : "Microphone access failed.";
}

function getRecordingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Voice input failed.";
}

function requestAudioStreamWithTimeout(
  constraints: MediaStreamConstraints,
): Promise<MediaStream> {
  let didTimeout = false;
  let timeoutId: number | null = null;
  const streamPromise = navigator.mediaDevices.getUserMedia(constraints);

  void streamPromise
    .then((stream) => {
      if (didTimeout) {
        stream.getTracks().forEach((track) => track.stop());
      }
    })
    .catch(() => {
      // The raced promise handles the visible error path.
    });

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      didTimeout = true;
      reject(
        new Error(
          "Microphone permission did not complete. Allow microphone access in the browser prompt and try again.",
        ),
      );
    }, MICROPHONE_OPEN_TIMEOUT_MS);
  });

  return Promise.race([streamPromise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  });
}

function isPermissionDeniedError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

async function buildExplicitAudioDeviceConstraints(): Promise<MediaStreamConstraints | null> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const audioInput =
    devices.find(
      (device) => device.kind === "audioinput" && device.deviceId === "default",
    ) ?? devices.find((device) => device.kind === "audioinput");

  if (!audioInput?.deviceId) {
    return null;
  }

  return {
    audio: {
      deviceId: { ideal: audioInput.deviceId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

async function requestAudioStream(): Promise<MediaStream> {
  try {
    return await requestAudioStreamWithTimeout({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (firstError) {
    if (isPermissionDeniedError(firstError)) {
      throw firstError;
    }

    const explicitConstraints = await buildExplicitAudioDeviceConstraints();

    if (!explicitConstraints) {
      throw firstError;
    }

    return requestAudioStreamWithTimeout(explicitConstraints);
  }
}

export function useVoiceCaptureSession({
  value,
  onChange,
  token,
  sessionId,
}: VoiceCaptureSessionOptions) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const baseValueRef = useRef(value);
  const startedAtRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const statusRef = useRef<VoiceCaptureStatus>(
    isAudioCaptureSupported() ? "idle" : "unsupported",
  );
  const captureIdRef = useRef(0);
  const unmountedRef = useRef(false);
  const cancellingRef = useRef(false);
  const stoppingRef = useRef(false);

  const [status, setStatus] = useState<VoiceCaptureStatus>(
    statusRef.current,
  );
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);

  useEffect(() => {
    baseValueRef.current = value;
  }, [value]);

  const setNextStatus = useCallback((nextStatus: VoiceCaptureStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current === null) {
      return;
    }

    window.clearInterval(durationTimerRef.current);
    durationTimerRef.current = null;
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const detachRecorder = useCallback(() => {
    const recorder = mediaRecorderRef.current;

    if (!recorder) {
      return;
    }

    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    mediaRecorderRef.current = null;
  }, []);

  const cleanupCapture = useCallback(() => {
    clearDurationTimer();
    detachRecorder();
    stopStream();
    startedAtRef.current = null;
    stoppingRef.current = false;
    cancellingRef.current = false;
  }, [clearDurationTimer, detachRecorder, stopStream]);

  const startDurationTimer = useCallback(() => {
    clearDurationTimer();
    durationTimerRef.current = window.setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt !== null) {
        setDurationMs(Date.now() - startedAt);
      }
    }, DURATION_TICK_MS);
  }, [clearDurationTimer]);

  const handleUnexpectedStop = useCallback(() => {
    if (
      unmountedRef.current ||
      cancellingRef.current ||
      stoppingRef.current ||
      statusRef.current !== "recording"
    ) {
      return;
    }

    cleanupCapture();
    setError("Recording stopped before you pressed Done. Please try again.");
    setNextStatus("error");
  }, [cleanupCapture, setNextStatus]);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle" && statusRef.current !== "error") {
      return;
    }

    if (!isAudioCaptureSupported()) {
      setError("Voice input is not supported in this browser.");
      setNextStatus("unsupported");
      return;
    }

    if (!token) {
      setError("Sign in again to use voice input.");
      setNextStatus("error");
      return;
    }

    cleanupCapture();
    chunksRef.current = [];
    setDurationMs(0);
    setError(null);
    setNextStatus("requestingPermission");
    const captureId = captureIdRef.current + 1;
    captureIdRef.current = captureId;

    try {
      const stream = await requestAudioStream();

      if (
        unmountedRef.current ||
        captureIdRef.current !== captureId
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const mimeType = chooseSupportedMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );

      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      startedAtRef.current = Date.now();
      baseValueRef.current = value;
      cancellingRef.current = false;
      stoppingRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        if (unmountedRef.current || cancellingRef.current) {
          return;
        }

        cleanupCapture();
        setError("Recording failed. Please try again.");
        setNextStatus("error");
      };
      recorder.onstop = handleUnexpectedStop;

      recorder.start();
      setNextStatus("recording");
      startDurationTimer();
    } catch (captureError) {
      cleanupCapture();
      setError(getPermissionErrorMessage(captureError));
      setNextStatus("error");
    }
  }, [
    cleanupCapture,
    handleUnexpectedStop,
    setNextStatus,
    startDurationTimer,
    token,
    value,
  ]);

  const waitForStop = useCallback(
    (recorder: MediaRecorder): Promise<Blob> =>
      new Promise((resolve, reject) => {
        let timeoutId: number | null = null;

        const settle = (callback: () => void) => {
          if (timeoutId !== null) {
            window.clearTimeout(timeoutId);
          }

          recorder.onstop = null;
          recorder.onerror = null;
          callback();
        };

        recorder.onstop = () => {
          settle(() => {
            const mimeType =
              recorder.mimeType || chooseSupportedMimeType() || "audio/webm";
            resolve(new Blob(chunksRef.current, { type: mimeType }));
          });
        };
        recorder.onerror = () => {
          settle(() => reject(new Error("Recording failed. Please try again.")));
        };

        timeoutId = window.setTimeout(() => {
          settle(() => reject(new Error("Recording did not stop cleanly.")));
        }, STOP_TIMEOUT_MS);

        try {
          if (recorder.state === "recording") {
            recorder.requestData();
          }

          if (recorder.state === "inactive") {
            recorder.onstop?.(new Event("stop"));
            return;
          }

          recorder.stop();
        } catch (stopError) {
          settle(() => reject(stopError));
        }
      }),
    [],
  );

  const done = useCallback(async () => {
    const recorder = mediaRecorderRef.current;

    if (!recorder || !token) {
      cleanupCapture();
      setNextStatus("idle");
      return;
    }

    stoppingRef.current = true;
    setError(null);
    setNextStatus("stopping");
    clearDurationTimer();

    const duration = startedAtRef.current
      ? Date.now() - startedAtRef.current
      : durationMs;

    try {
      const audio = await waitForStop(recorder);
      cleanupCapture();

      if (duration < MIN_RECORDING_MS || audio.size <= 0) {
        throw new Error("Voice input was too short to transcribe.");
      }

      setNextStatus("transcribing");
      const mimeType = audio.type || recorder.mimeType || "audio/webm";
      const result = await transcribeChatVoice({
        audio,
        token,
        sessionId,
        durationMs: duration,
        fileName: `voice-input.${getFileExtension(mimeType)}`,
        clientRequestId:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : undefined,
      });

      onChange(appendTranscript(baseValueRef.current, result.transcript));
      setDurationMs(0);
      setError(null);
      setNextStatus("idle");
    } catch (voiceError) {
      cleanupCapture();
      setError(getRecordingErrorMessage(voiceError));
      setNextStatus("error");
    }
  }, [
    cleanupCapture,
    clearDurationTimer,
    durationMs,
    onChange,
    sessionId,
    setNextStatus,
    token,
    waitForStop,
  ]);

  const cancel = useCallback(() => {
    captureIdRef.current += 1;
    cancellingRef.current = true;

    const recorder = mediaRecorderRef.current;
    detachRecorder();

    try {
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
    } catch {
      // The recorder may already be inactive.
    }

    chunksRef.current = [];
    cleanupCapture();
    setDurationMs(0);
    setError(null);
    setNextStatus("idle");
  }, [cleanupCapture, detachRecorder, setNextStatus]);

  useEffect(
    () => {
      unmountedRef.current = false;

      return () => {
        unmountedRef.current = true;
        captureIdRef.current += 1;
        cancellingRef.current = true;

        const recorder = mediaRecorderRef.current;
        detachRecorder();

        try {
          if (recorder && recorder.state !== "inactive") {
            recorder.stop();
          }
        } catch {
          // The recorder may already be inactive.
        }

        chunksRef.current = [];
        cleanupCapture();
      };
    },
    [cleanupCapture, detachRecorder],
  );

  return {
    status,
    error,
    durationMs,
    isSupported: status !== "unsupported",
    isSessionActive:
      status === "requestingPermission" ||
      status === "recording" ||
      status === "stopping" ||
      status === "transcribing",
    start,
    done,
    cancel,
  };
}
