use std::alloc::{alloc, dealloc, Layout};
use std::ptr;
use std::slice;
use std::str;

extern "C" {
    fn overlord_emit(event: *const u8, event_len: i32, payload: *const u8, payload_len: i32) -> i32;
    fn overlord_host_info(out: *mut u8, out_len: i32) -> i32;
    fn overlord_fs_mkdir(bucket: *const u8, bucket_len: i32, path: *const u8, path_len: i32) -> i32;
    fn overlord_fs_write(
        bucket: *const u8,
        bucket_len: i32,
        path: *const u8,
        path_len: i32,
        data: *const u8,
        data_len: i32,
    ) -> i32;
}

#[no_mangle]
pub extern "C" fn overlord_alloc(size: u32) -> *mut u8 {
    let size = size.max(1) as usize;
    let layout = Layout::from_size_align(size, 8).unwrap();
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn overlord_free(ptr: *mut u8, size: u32) {
    if ptr.is_null() {
        return;
    }
    let layout = Layout::from_size_align((size.max(1)) as usize, 8).unwrap();
    unsafe { dealloc(ptr, layout) };
}

#[no_mangle]
pub extern "C" fn overlord_on_load(_host: *const u8, _host_len: u32) -> i32 {
    emit("ready", br#"{"sample":"platform-note"}"#);
    0
}

#[no_mangle]
pub extern "C" fn overlord_on_event(
    event: *const u8,
    event_len: u32,
    _payload: *const u8,
    _payload_len: u32,
) -> i32 {
    let event = unsafe { slice::from_raw_parts(event, event_len as usize) };
    if event != b"write_note" {
        return 0;
    }

    let mut host = [0u8; 1024];
    let host_len = unsafe { overlord_host_info(host.as_mut_ptr(), host.len() as i32) };
    let host = if host_len > 0 {
        str::from_utf8(&host[..host_len as usize]).unwrap_or("")
    } else {
        ""
    };

    let os = if host.contains(r#""os":"windows""#) {
        "windows"
    } else if host.contains(r#""os":"darwin""#) {
        "darwin"
    } else if host.contains(r#""os":"linux""#) {
        "linux"
    } else {
        "unknown"
    };

    let arch = if host.contains(r#""arch":"arm64""#) {
        "arm64"
    } else if host.contains(r#""arch":"amd64""#) {
        "amd64"
    } else if host.contains(r#""arch":"386""#) {
        "386"
    } else {
        "unknown"
    };

    let bucket = "pluginData";
    let dir = "platform";
    let file = format!("platform/{os}-{arch}.txt");
    let note = format!("single WASM plugin running on os={os} arch={arch}\n");

    let mkdir_result = unsafe {
        overlord_fs_mkdir(
            bucket.as_ptr(),
            bucket.len() as i32,
            dir.as_ptr(),
            dir.len() as i32,
        )
    };
    let write_result = unsafe {
        overlord_fs_write(
            bucket.as_ptr(),
            bucket.len() as i32,
            file.as_ptr(),
            file.len() as i32,
            note.as_ptr(),
            note.len() as i32,
        )
    };

    let response = format!(
        r#"{{"os":"{os}","arch":"{arch}","mkdir":{mkdir_result},"write":{write_result}}}"#
    );
    emit("platform_note", response.as_bytes());
    0
}

#[no_mangle]
pub extern "C" fn overlord_on_unload() {}

fn emit(event: &str, payload: &[u8]) {
    unsafe {
        overlord_emit(
            event.as_ptr(),
            event.len() as i32,
            payload.as_ptr(),
            payload.len() as i32,
        );
    }
}

#[no_mangle]
pub extern "C" fn memset(dest: *mut u8, value: i32, len: usize) -> *mut u8 {
    unsafe { ptr::write_bytes(dest, value as u8, len) };
    dest
}
