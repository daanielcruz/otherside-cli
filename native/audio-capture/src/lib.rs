use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};

enum Command {
    Stop,
}

struct Capture {
    command: Sender<Command>,
    worker: JoinHandle<()>,
}

static ACTIVE: OnceLock<Mutex<Option<Capture>>> = OnceLock::new();

fn active() -> &'static Mutex<Option<Capture>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    callback: ThreadsafeFunction<Buffer>,
    error_callback: ThreadsafeFunction<String>,
) -> std::result::Result<Stream, String>
where
    T: Sample + SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    if channels == 0 {
        return Err("microphone reported zero channels".into());
    }
    device
        .build_input_stream(
            config,
            move |samples: &[T], _| {
                let frames = samples.len() / channels;
                let mut bytes = Vec::with_capacity(frames * 4);
                for frame in samples.chunks_exact(channels) {
                    let mut mono = 0.0f32;
                    for sample in frame {
                        mono += f32::from_sample(*sample);
                    }
                    mono /= channels as f32;
                    bytes.extend_from_slice(&mono.to_le_bytes());
                }
                callback.call(
                    Ok(Buffer::from(bytes)),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            },
            move |error| {
                error_callback.call(
                    Ok(error.to_string()),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            },
            None,
        )
        .map_err(|error| error.to_string())
}

fn run_capture(
    callback: ThreadsafeFunction<Buffer>,
    error_callback: ThreadsafeFunction<String>,
    command_rx: mpsc::Receiver<Command>,
    ready_tx: mpsc::Sender<std::result::Result<(u32, u16), String>>,
) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = ready_tx.send(Err("no default microphone is available".into()));
        return;
    };
    let supported = match device.default_input_config() {
        Ok(config) => config,
        Err(error) => {
            let _ = ready_tx.send(Err(error.to_string()));
            return;
        }
    };
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let stream = match format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, callback, error_callback),
        SampleFormat::I16 => build_stream::<i16>(&device, &config, callback, error_callback),
        SampleFormat::U16 => build_stream::<u16>(&device, &config, callback, error_callback),
        _ => Err(format!("unsupported microphone sample format {format}")),
    };
    let stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ready_tx.send(Err(error));
            return;
        }
    };
    if let Err(error) = stream.play() {
        let _ = ready_tx.send(Err(error.to_string()));
        return;
    }
    let _ = ready_tx.send(Ok((config.sample_rate, config.channels)));
    let _ = command_rx.recv();
    drop(stream);
}

#[napi(object)]
pub struct CaptureInfo {
    pub sample_rate: u32,
    pub channels: u32,
}

#[napi]
pub fn start_capture(
    callback: ThreadsafeFunction<Buffer>,
    error_callback: ThreadsafeFunction<String>,
) -> Result<CaptureInfo> {
    stop_capture()?;
    let (command_tx, command_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("otherside-audio-capture".into())
        .spawn(move || run_capture(callback, error_callback, command_rx, ready_tx))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    let ready = ready_rx
        .recv()
        .map_err(|error| Error::from_reason(error.to_string()))?;
    match ready {
        Ok((sample_rate, channels)) => {
            *active()
                .lock()
                .map_err(|_| Error::from_reason("audio capture lock poisoned"))? = Some(Capture {
                command: command_tx,
                worker,
            });
            Ok(CaptureInfo {
                sample_rate,
                channels: channels as u32,
            })
        }
        Err(message) => {
            let _ = worker.join();
            Err(Error::from_reason(message))
        }
    }
}

#[napi]
pub fn stop_capture() -> Result<()> {
    let capture = active()
        .lock()
        .map_err(|_| Error::from_reason("audio capture lock poisoned"))?
        .take();
    if let Some(capture) = capture {
        let _ = capture.command.send(Command::Stop);
        capture
            .worker
            .join()
            .map_err(|_| Error::from_reason("audio capture worker panicked"))?;
    }
    Ok(())
}

#[napi]
pub fn is_capture_active() -> Result<bool> {
    Ok(active()
        .lock()
        .map_err(|_| Error::from_reason("audio capture lock poisoned"))?
        .is_some())
}
