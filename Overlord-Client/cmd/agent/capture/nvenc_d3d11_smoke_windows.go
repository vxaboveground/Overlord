//go:build windows && cgo

package capture

/*
#cgo windows CFLAGS: -I../../../third_party/nvcodec
#cgo windows LDFLAGS: -ld3d11 -ldxgi
#include <windows.h>
#include <d3d11.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "nvEncodeAPI.h"

typedef NVENCSTATUS (NVENCAPI *nvenc_create_instance_fn)(NV_ENCODE_API_FUNCTION_LIST*);

typedef struct nvenc_d3d11_smoke_result {
	int ok;
	int stage;
	HRESULT hr;
	NVENCSTATUS nvstatus;
	int width;
	int height;
	int fps;
	int frames;
	double first_ms;
	double avg_ms;
	uint64_t total_bytes;
	char message[256];
} nvenc_d3d11_smoke_result;

typedef struct nvenc_d3d11_encoder {
	ID3D11Device *device;
	ID3D11DeviceContext *context;
	ID3D11Texture2D *texture;
	HMODULE dll;
	NV_ENCODE_API_FUNCTION_LIST api;
	void *encoder;
	NV_ENC_REGISTERED_PTR registered_resource;
	NV_ENC_OUTPUT_PTR bitstream;
	int width;
	int height;
	int fps;
	uint32_t frame;
} nvenc_d3d11_encoder;

typedef struct nvenc_d3d11_create_result {
	nvenc_d3d11_encoder *encoder;
	int stage;
	HRESULT hr;
	NVENCSTATUS nvstatus;
	char message[256];
} nvenc_d3d11_create_result;

typedef struct nvenc_d3d11_encode_result {
	int stage;
	NVENCSTATUS nvstatus;
	uint8_t *data;
	int size;
	double copy_ms;
	double blt_ms;
	double map_ms;
	double submit_ms;
	double lock_ms;
	char message[256];
} nvenc_d3d11_encode_result;

#define NVENC_D3D11_TEXTURE_PIPELINE_DEPTH 3

typedef struct nvenc_d3d11_texture_slot {
	ID3D11VideoProcessorInputView *video_input_view;
	ID3D11VideoProcessorOutputView *video_output_view;
	ID3D11Texture2D *source_texture;
	ID3D11Texture2D *input_texture;
	NV_ENC_REGISTERED_PTR registered_resource;
	NV_ENC_OUTPUT_PTR bitstream;
	NV_ENC_INPUT_PTR mapped_resource;
	int in_flight;
} nvenc_d3d11_texture_slot;

typedef struct nvenc_d3d11_texture_encoder {
	ID3D11Device *device;
	ID3D11DeviceContext *context;
	ID3D11VideoDevice *video_device;
	ID3D11VideoContext *video_context;
	ID3D11VideoProcessorEnumerator *video_enum;
	ID3D11VideoProcessor *video_processor;
	nvenc_d3d11_texture_slot slots[NVENC_D3D11_TEXTURE_PIPELINE_DEPTH];
	HMODULE dll;
	NV_ENCODE_API_FUNCTION_LIST api;
	void *encoder;
	NV_ENC_BUFFER_FORMAT buffer_format;
	int input_width;
	int input_height;
	int encode_width;
	int encode_height;
	int fps;
	int use_video_processor;
	int output_mode;
	int slot_index;
	int pending_count;
	uint32_t frame;
} nvenc_d3d11_texture_encoder;

typedef struct nvenc_d3d11_texture_create_result {
	nvenc_d3d11_texture_encoder *encoder;
	int stage;
	HRESULT hr;
	NVENCSTATUS nvstatus;
	char message[256];
} nvenc_d3d11_texture_create_result;

static const GUID nvenc_iid_id3d11_video_device = {0x10ec4d5b, 0x975a, 0x4689, {0xb9,0xe4,0xd0,0xaa,0xc3,0x0f,0xe3,0x33}};
static const GUID nvenc_iid_id3d11_video_context = {0x61f21c45, 0x3c0e, 0x4a74, {0x9c,0xea,0x67,0x10,0x0d,0x9a,0xd5,0xe4}};

static double nvenc_qpc_ms(LARGE_INTEGER start, LARGE_INTEGER end, LARGE_INTEGER freq) {
	return ((double)(end.QuadPart - start.QuadPart) * 1000.0) / (double)freq.QuadPart;
}

static void nvenc_configure_h264_stream(NV_ENC_CONFIG *cfg, int fps) {
	(void)fps;
	cfg->gopLength = NVENC_INFINITE_GOPLENGTH;
	cfg->frameIntervalP = 1;
	cfg->encodeCodecConfig.h264Config.idrPeriod = NVENC_INFINITE_GOPLENGTH;
	cfg->encodeCodecConfig.h264Config.repeatSPSPPS = 1;
	cfg->encodeCodecConfig.h264Config.level = NV_ENC_LEVEL_H264_52;
	cfg->encodeCodecConfig.h264Config.h264VUIParameters.videoSignalTypePresentFlag = 1;
	cfg->encodeCodecConfig.h264Config.h264VUIParameters.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;
	cfg->encodeCodecConfig.h264Config.h264VUIParameters.videoFullRangeFlag = 0;
	cfg->encodeCodecConfig.h264Config.h264VUIParameters.colourDescriptionPresentFlag = 1;
	cfg->encodeCodecConfig.h264Config.h264VUIParameters.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT709;
	cfg->encodeCodecConfig.h264Config.h264VUIParameters.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709;
	cfg->encodeCodecConfig.h264Config.h264VUIParameters.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_BT709;
}

static void nvenc_set_video_processor_color_space(nvenc_d3d11_texture_encoder *enc) {
	D3D11_VIDEO_PROCESSOR_COLOR_SPACE input_space;
	memset(&input_space, 0, sizeof(input_space));
	input_space.Usage = 1;
	input_space.RGB_Range = 0;
	input_space.YCbCr_Matrix = 1;
	input_space.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;

	D3D11_VIDEO_PROCESSOR_COLOR_SPACE output_space;
	memset(&output_space, 0, sizeof(output_space));
	output_space.Usage = 1;
	output_space.RGB_Range = 0;
	output_space.YCbCr_Matrix = 1;
	output_space.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;

	enc->video_context->lpVtbl->VideoProcessorSetStreamColorSpace(enc->video_context, enc->video_processor, 0, &input_space);
	enc->video_context->lpVtbl->VideoProcessorSetOutputColorSpace(enc->video_context, enc->video_processor, &output_space);
}

static void nvenc_set_msg(nvenc_d3d11_smoke_result *out, const char *msg) {
	if (!msg) {
		out->message[0] = 0;
		return;
	}
	strncpy(out->message, msg, sizeof(out->message)-1);
	out->message[sizeof(out->message)-1] = 0;
}

static void nvenc_fail_hr(nvenc_d3d11_smoke_result *out, int stage, HRESULT hr, const char *msg) {
	out->stage = stage;
	out->hr = hr;
	nvenc_set_msg(out, msg);
}

static void nvenc_fail_status(nvenc_d3d11_smoke_result *out, int stage, NVENCSTATUS status, const char *msg) {
	out->stage = stage;
	out->nvstatus = status;
	nvenc_set_msg(out, msg);
}

static uint8_t* nvenc_alloc_nv12_frame(int width, int height) {
	size_t y = (size_t)width * (size_t)height;
	size_t total = y + y / 2;
	uint8_t *buf = (uint8_t*)malloc(total);
	if (!buf) {
		return NULL;
	}
	memset(buf, 0x10, y);
	memset(buf + y, 0x80, y / 2);
	return buf;
}

static uint8_t* nvenc_alloc_bgra_frame(int width, int height) {
	size_t total = (size_t)width * (size_t)height * 4;
	uint8_t *buf = (uint8_t*)malloc(total);
	if (!buf) {
		return NULL;
	}
	for (int row = 0; row < height; row++) {
		for (int col = 0; col < width; col++) {
			size_t off = ((size_t)row * (size_t)width + (size_t)col) * 4;
			buf[off + 0] = (uint8_t)((col / 8) & 0xff);
			buf[off + 1] = (uint8_t)((row / 8) & 0xff);
			buf[off + 2] = (uint8_t)(((col + row) / 16) & 0xff);
			buf[off + 3] = 0xff;
		}
	}
	return buf;
}

static void nvenc_release_encoder(nvenc_d3d11_encoder *enc) {
	if (!enc) {
		return;
	}
	if (enc->api.nvEncDestroyBitstreamBuffer && enc->encoder && enc->bitstream) {
		enc->api.nvEncDestroyBitstreamBuffer(enc->encoder, enc->bitstream);
	}
	if (enc->api.nvEncUnregisterResource && enc->encoder && enc->registered_resource) {
		enc->api.nvEncUnregisterResource(enc->encoder, enc->registered_resource);
	}
	if (enc->texture) {
		enc->texture->lpVtbl->Release(enc->texture);
	}
	if (enc->api.nvEncDestroyEncoder && enc->encoder) {
		enc->api.nvEncDestroyEncoder(enc->encoder);
	}
	if (enc->dll) {
		FreeLibrary(enc->dll);
	}
	if (enc->context) {
		enc->context->lpVtbl->Release(enc->context);
	}
	if (enc->device) {
		enc->device->lpVtbl->Release(enc->device);
	}
	free(enc);
}

static void nvenc_release_texture_encoder(nvenc_d3d11_texture_encoder *enc) {
	if (!enc) {
		return;
	}
	for (int i = 0; i < NVENC_D3D11_TEXTURE_PIPELINE_DEPTH; i++) {
		nvenc_d3d11_texture_slot *slot = &enc->slots[i];
		if (enc->api.nvEncUnmapInputResource && enc->encoder && slot->mapped_resource) {
			enc->api.nvEncUnmapInputResource(enc->encoder, slot->mapped_resource);
		}
		if (enc->api.nvEncDestroyBitstreamBuffer && enc->encoder && slot->bitstream) {
			enc->api.nvEncDestroyBitstreamBuffer(enc->encoder, slot->bitstream);
		}
		if (enc->api.nvEncUnregisterResource && enc->encoder && slot->registered_resource) {
			enc->api.nvEncUnregisterResource(enc->encoder, slot->registered_resource);
		}
		if (slot->video_output_view) {
			slot->video_output_view->lpVtbl->Release(slot->video_output_view);
		}
		if (slot->video_input_view) {
			slot->video_input_view->lpVtbl->Release(slot->video_input_view);
		}
		if (slot->source_texture) {
			slot->source_texture->lpVtbl->Release(slot->source_texture);
		}
		if (slot->input_texture) {
			slot->input_texture->lpVtbl->Release(slot->input_texture);
		}
	}
	if (enc->video_processor) {
		enc->video_processor->lpVtbl->Release(enc->video_processor);
	}
	if (enc->video_enum) {
		enc->video_enum->lpVtbl->Release(enc->video_enum);
	}
	if (enc->video_context) {
		enc->video_context->lpVtbl->Release(enc->video_context);
	}
	if (enc->video_device) {
		enc->video_device->lpVtbl->Release(enc->video_device);
	}
	if (enc->api.nvEncDestroyEncoder && enc->encoder) {
		enc->api.nvEncDestroyEncoder(enc->encoder);
	}
	if (enc->dll) {
		FreeLibrary(enc->dll);
	}
	if (enc->context) {
		enc->context->lpVtbl->Release(enc->context);
	}
	if (enc->device) {
		enc->device->lpVtbl->Release(enc->device);
	}
	free(enc);
}

static nvenc_d3d11_texture_create_result nvenc_create_d3d11_texture_encoder(ID3D11Device *device, int input_width, int input_height, int encode_width, int encode_height, int fps, int bitrate, NV_ENC_BUFFER_FORMAT buffer_format, int dxgi_format, int output_mode) {
	nvenc_d3d11_texture_create_result out;
	memset(&out, 0, sizeof(out));
	if (!device) {
		out.stage = 1;
		out.nvstatus = NV_ENC_ERR_INVALID_PTR;
		strncpy(out.message, "nil D3D11 device", sizeof(out.message)-1);
		return out;
	}
	if (input_width <= 0 || input_height <= 0 || encode_width <= 0 || encode_height <= 0 || (input_width & 1) || (input_height & 1) || (encode_width & 1) || (encode_height & 1) || fps <= 0) {
		out.stage = 2;
		out.nvstatus = NV_ENC_ERR_INVALID_PARAM;
		strncpy(out.message, "input/output width/height/fps must be positive, and dimensions must be even", sizeof(out.message)-1);
		return out;
	}

	nvenc_d3d11_texture_encoder *enc = (nvenc_d3d11_texture_encoder*)calloc(1, sizeof(nvenc_d3d11_texture_encoder));
	if (!enc) {
		out.stage = 3;
		out.nvstatus = NV_ENC_ERR_OUT_OF_MEMORY;
		strncpy(out.message, "alloc texture encoder failed", sizeof(out.message)-1);
		return out;
	}
	enc->device = device;
	enc->device->lpVtbl->AddRef(enc->device);
	enc->device->lpVtbl->GetImmediateContext(enc->device, &enc->context);
	if (!enc->context) {
		out.stage = 4;
		out.nvstatus = NV_ENC_ERR_INVALID_PTR;
		strncpy(out.message, "GetImmediateContext failed", sizeof(out.message)-1);
		nvenc_release_texture_encoder(enc);
		return out;
	}
	enc->input_width = input_width;
	enc->input_height = input_height;
	enc->encode_width = encode_width;
	enc->encode_height = encode_height;
	enc->fps = fps;
	enc->buffer_format = buffer_format;
	enc->output_mode = output_mode;

	enc->dll = LoadLibraryA("nvEncodeAPI64.dll");
	if (!enc->dll) {
		out.stage = 5;
		out.hr = HRESULT_FROM_WIN32(GetLastError());
		strncpy(out.message, "LoadLibrary nvEncodeAPI64.dll failed", sizeof(out.message)-1);
		nvenc_release_texture_encoder(enc);
		return out;
	}
	nvenc_create_instance_fn create_instance = (nvenc_create_instance_fn)GetProcAddress(enc->dll, "NvEncodeAPICreateInstance");
	if (!create_instance) {
		out.stage = 6;
		out.hr = HRESULT_FROM_WIN32(GetLastError());
		strncpy(out.message, "NvEncodeAPICreateInstance not found", sizeof(out.message)-1);
		nvenc_release_texture_encoder(enc);
		return out;
	}

	enc->api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
	NVENCSTATUS status = create_instance(&enc->api);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 7;
		out.nvstatus = status;
		strncpy(out.message, "NvEncodeAPICreateInstance failed", sizeof(out.message)-1);
		nvenc_release_texture_encoder(enc);
		return out;
	}

	NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open_params;
	memset(&open_params, 0, sizeof(open_params));
	open_params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
	open_params.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
	open_params.device = enc->device;
	open_params.apiVersion = NVENCAPI_VERSION;
	status = enc->api.nvEncOpenEncodeSessionEx(&open_params, &enc->encoder);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 8;
		out.nvstatus = status;
		strncpy(out.message, "nvEncOpenEncodeSessionEx failed", sizeof(out.message)-1);
		nvenc_release_texture_encoder(enc);
		return out;
	}

	NV_ENC_PRESET_CONFIG preset;
	memset(&preset, 0, sizeof(preset));
	preset.version = NV_ENC_PRESET_CONFIG_VER;
	preset.presetCfg.version = NV_ENC_CONFIG_VER;
	status = enc->api.nvEncGetEncodePresetConfigEx(enc->encoder, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P1_GUID, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 9;
		out.nvstatus = status;
		strncpy(out.message, "nvEncGetEncodePresetConfigEx failed", sizeof(out.message)-1);
		nvenc_release_texture_encoder(enc);
		return out;
	}
	preset.presetCfg.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
	preset.presetCfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
	preset.presetCfg.rcParams.averageBitRate = (uint32_t)bitrate;
	preset.presetCfg.rcParams.maxBitRate = (uint32_t)bitrate;
	preset.presetCfg.rcParams.vbvBufferSize = (uint32_t)(bitrate / fps);
	preset.presetCfg.rcParams.vbvInitialDelay = (uint32_t)(bitrate / fps);
	nvenc_configure_h264_stream(&preset.presetCfg, fps);

	NV_ENC_INITIALIZE_PARAMS init;
	memset(&init, 0, sizeof(init));
	init.version = NV_ENC_INITIALIZE_PARAMS_VER;
	init.encodeGUID = NV_ENC_CODEC_H264_GUID;
	init.presetGUID = NV_ENC_PRESET_P1_GUID;
	init.encodeWidth = (uint32_t)encode_width;
	init.encodeHeight = (uint32_t)encode_height;
	init.darWidth = (uint32_t)encode_width;
	init.darHeight = (uint32_t)encode_height;
	init.frameRateNum = (uint32_t)fps;
	init.frameRateDen = 1;
	init.enableEncodeAsync = 0;
	init.enablePTD = 1;
	init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
	init.encodeConfig = &preset.presetCfg;
	status = enc->api.nvEncInitializeEncoder(enc->encoder, &init);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 10;
		out.nvstatus = status;
		strncpy(out.message, "nvEncInitializeEncoder failed", sizeof(out.message)-1);
		nvenc_release_texture_encoder(enc);
		return out;
	}

	DXGI_FORMAT output_dxgi_format = output_mode == 1 ? (DXGI_FORMAT)dxgi_format : DXGI_FORMAT_NV12;
	NV_ENC_BUFFER_FORMAT output_buffer_format = output_mode == 1 ? buffer_format : NV_ENC_BUFFER_FORMAT_NV12;
	int direct_copy = output_mode == 1 && input_width == encode_width && input_height == encode_height;
	HRESULT hr = S_OK;

	if (!direct_copy) {
		hr = enc->device->lpVtbl->QueryInterface(enc->device, &nvenc_iid_id3d11_video_device, (void**)&enc->video_device);
		if (FAILED(hr) || !enc->video_device) {
			out.stage = 11;
			out.hr = hr;
			strncpy(out.message, "ID3D11VideoDevice unavailable for GPU conversion/scaling", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}
		hr = enc->context->lpVtbl->QueryInterface(enc->context, &nvenc_iid_id3d11_video_context, (void**)&enc->video_context);
		if (FAILED(hr) || !enc->video_context) {
			out.stage = 12;
			out.hr = hr;
			strncpy(out.message, "ID3D11VideoContext unavailable for GPU conversion/scaling", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}

		D3D11_VIDEO_PROCESSOR_CONTENT_DESC content_desc;
		memset(&content_desc, 0, sizeof(content_desc));
		content_desc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
		content_desc.InputFrameRate.Numerator = (UINT)fps;
		content_desc.InputFrameRate.Denominator = 1;
		content_desc.InputWidth = (UINT)input_width;
		content_desc.InputHeight = (UINT)input_height;
		content_desc.OutputFrameRate.Numerator = (UINT)fps;
		content_desc.OutputFrameRate.Denominator = 1;
		content_desc.OutputWidth = (UINT)encode_width;
		content_desc.OutputHeight = (UINT)encode_height;
		content_desc.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
		hr = enc->video_device->lpVtbl->CreateVideoProcessorEnumerator(enc->video_device, &content_desc, &enc->video_enum);
		if (FAILED(hr) || !enc->video_enum) {
			out.stage = 13;
			out.hr = hr;
			strncpy(out.message, "CreateVideoProcessorEnumerator failed for GPU conversion/scaling", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}
		UINT format_flags = 0;
		hr = enc->video_enum->lpVtbl->CheckVideoProcessorFormat(enc->video_enum, (DXGI_FORMAT)dxgi_format, &format_flags);
		if (FAILED(hr) || !(format_flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT)) {
			out.stage = 14;
			out.hr = FAILED(hr) ? hr : E_FAIL;
			strncpy(out.message, "desktop DXGI format is not supported as D3D11 video processor input", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}
		format_flags = 0;
		hr = enc->video_enum->lpVtbl->CheckVideoProcessorFormat(enc->video_enum, output_dxgi_format, &format_flags);
		if (FAILED(hr) || !(format_flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) {
			out.stage = 15;
			out.hr = FAILED(hr) ? hr : E_FAIL;
			strncpy(out.message, "requested D3D11 video processor output format is not supported", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}
		hr = enc->video_device->lpVtbl->CreateVideoProcessor(enc->video_device, enc->video_enum, 0, &enc->video_processor);
		if (FAILED(hr) || !enc->video_processor) {
			out.stage = 16;
			out.hr = hr;
			strncpy(out.message, "CreateVideoProcessor failed for GPU conversion/scaling", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}
	}

	D3D11_TEXTURE2D_DESC source_desc;
	memset(&source_desc, 0, sizeof(source_desc));
	source_desc.Width = (UINT)input_width;
	source_desc.Height = (UINT)input_height;
	source_desc.MipLevels = 1;
	source_desc.ArraySize = 1;
	source_desc.Format = (DXGI_FORMAT)dxgi_format;
	source_desc.SampleDesc.Count = 1;
	source_desc.Usage = D3D11_USAGE_DEFAULT;
	source_desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

	D3D11_TEXTURE2D_DESC tex_desc;
	memset(&tex_desc, 0, sizeof(tex_desc));
	tex_desc.Width = (UINT)encode_width;
	tex_desc.Height = (UINT)encode_height;
	tex_desc.MipLevels = 1;
	tex_desc.ArraySize = 1;
	tex_desc.Format = output_dxgi_format;
	tex_desc.SampleDesc.Count = 1;
	tex_desc.Usage = D3D11_USAGE_DEFAULT;
	tex_desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

	D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input_view_desc;
	memset(&input_view_desc, 0, sizeof(input_view_desc));
	input_view_desc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
	input_view_desc.Texture2D.MipSlice = 0;
	input_view_desc.Texture2D.ArraySlice = 0;

	D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output_view_desc;
	memset(&output_view_desc, 0, sizeof(output_view_desc));
	output_view_desc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
	output_view_desc.Texture2D.MipSlice = 0;
	for (int i = 0; i < NVENC_D3D11_TEXTURE_PIPELINE_DEPTH; i++) {
		nvenc_d3d11_texture_slot *slot = &enc->slots[i];
		if (!direct_copy) {
			hr = enc->device->lpVtbl->CreateTexture2D(enc->device, &source_desc, NULL, &slot->source_texture);
			if (FAILED(hr) || !slot->source_texture) {
				out.stage = 17;
				out.hr = hr;
				strncpy(out.message, "CreateTexture2D desktop video-processor input failed", sizeof(out.message)-1);
				nvenc_release_texture_encoder(enc);
				return out;
			}
		}
		hr = enc->device->lpVtbl->CreateTexture2D(enc->device, &tex_desc, NULL, &slot->input_texture);
		if (FAILED(hr) || !slot->input_texture) {
			out.stage = 18;
			out.hr = hr;
			strncpy(out.message, direct_copy ? "CreateTexture2D direct NVENC input failed" : "CreateTexture2D video-processor output failed", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}
		if (!direct_copy) {
			hr = enc->video_device->lpVtbl->CreateVideoProcessorInputView(enc->video_device, (ID3D11Resource*)slot->source_texture, enc->video_enum, &input_view_desc, &slot->video_input_view);
			if (FAILED(hr) || !slot->video_input_view) {
				out.stage = 19;
				out.hr = hr;
				strncpy(out.message, "CreateVideoProcessorInputView failed", sizeof(out.message)-1);
				nvenc_release_texture_encoder(enc);
				return out;
			}
			hr = enc->video_device->lpVtbl->CreateVideoProcessorOutputView(enc->video_device, (ID3D11Resource*)slot->input_texture, enc->video_enum, &output_view_desc, &slot->video_output_view);
			if (FAILED(hr) || !slot->video_output_view) {
				out.stage = 20;
				out.hr = hr;
				strncpy(out.message, "CreateVideoProcessorOutputView failed", sizeof(out.message)-1);
				nvenc_release_texture_encoder(enc);
				return out;
			}
		}

		NV_ENC_REGISTER_RESOURCE reg;
		memset(&reg, 0, sizeof(reg));
		reg.version = NV_ENC_REGISTER_RESOURCE_VER;
		reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
		reg.width = (uint32_t)enc->encode_width;
		reg.height = (uint32_t)enc->encode_height;
		reg.pitch = 0;
		reg.resourceToRegister = slot->input_texture;
		reg.bufferFormat = output_buffer_format;
		reg.bufferUsage = NV_ENC_INPUT_IMAGE;
		status = enc->api.nvEncRegisterResource(enc->encoder, &reg);
		if (status != NV_ENC_SUCCESS) {
			out.stage = 21;
			out.nvstatus = status;
			strncpy(out.message, "nvEncRegisterResource failed", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}
		slot->registered_resource = reg.registeredResource;

		NV_ENC_CREATE_BITSTREAM_BUFFER bs;
		memset(&bs, 0, sizeof(bs));
		bs.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
		status = enc->api.nvEncCreateBitstreamBuffer(enc->encoder, &bs);
		if (status != NV_ENC_SUCCESS) {
			out.stage = 22;
			out.nvstatus = status;
			strncpy(out.message, "nvEncCreateBitstreamBuffer failed", sizeof(out.message)-1);
			nvenc_release_texture_encoder(enc);
			return out;
		}
		slot->bitstream = bs.bitstreamBuffer;
	}
	enc->use_video_processor = direct_copy ? 0 : 1;
	out.encoder = enc;
	return out;
}

static nvenc_d3d11_create_result nvenc_create_d3d11_encoder(int width, int height, int fps, int bitrate) {
	nvenc_d3d11_create_result out;
	memset(&out, 0, sizeof(out));
	if (width <= 0 || height <= 0 || (width & 1) || (height & 1) || fps <= 0) {
		out.stage = 1;
		out.nvstatus = NV_ENC_ERR_INVALID_PARAM;
		strncpy(out.message, "width/height/fps must be positive, and width/height must be even", sizeof(out.message)-1);
		return out;
	}

	nvenc_d3d11_encoder *enc = (nvenc_d3d11_encoder*)calloc(1, sizeof(nvenc_d3d11_encoder));
	if (!enc) {
		out.stage = 2;
		out.nvstatus = NV_ENC_ERR_OUT_OF_MEMORY;
		strncpy(out.message, "alloc encoder failed", sizeof(out.message)-1);
		return out;
	}
	enc->width = width;
	enc->height = height;
	enc->fps = fps;

	D3D_FEATURE_LEVEL got_level;
	D3D_FEATURE_LEVEL levels[] = {
		D3D_FEATURE_LEVEL_11_1,
		D3D_FEATURE_LEVEL_11_0,
		D3D_FEATURE_LEVEL_10_1,
		D3D_FEATURE_LEVEL_10_0,
	};
	HRESULT hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL,
		D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 4, D3D11_SDK_VERSION,
		&enc->device, &got_level, &enc->context);
	if (FAILED(hr)) {
		out.stage = 3;
		out.hr = hr;
		strncpy(out.message, "D3D11CreateDevice failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}

	enc->dll = LoadLibraryA("nvEncodeAPI64.dll");
	if (!enc->dll) {
		out.stage = 4;
		out.hr = HRESULT_FROM_WIN32(GetLastError());
		strncpy(out.message, "LoadLibrary nvEncodeAPI64.dll failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}
	nvenc_create_instance_fn create_instance = (nvenc_create_instance_fn)GetProcAddress(enc->dll, "NvEncodeAPICreateInstance");
	if (!create_instance) {
		out.stage = 5;
		out.hr = HRESULT_FROM_WIN32(GetLastError());
		strncpy(out.message, "NvEncodeAPICreateInstance not found", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}

	enc->api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
	NVENCSTATUS status = create_instance(&enc->api);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 6;
		out.nvstatus = status;
		strncpy(out.message, "NvEncodeAPICreateInstance failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}

	NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open_params;
	memset(&open_params, 0, sizeof(open_params));
	open_params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
	open_params.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
	open_params.device = enc->device;
	open_params.apiVersion = NVENCAPI_VERSION;
	status = enc->api.nvEncOpenEncodeSessionEx(&open_params, &enc->encoder);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 7;
		out.nvstatus = status;
		strncpy(out.message, "nvEncOpenEncodeSessionEx failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}

	NV_ENC_PRESET_CONFIG preset;
	memset(&preset, 0, sizeof(preset));
	preset.version = NV_ENC_PRESET_CONFIG_VER;
	preset.presetCfg.version = NV_ENC_CONFIG_VER;
	status = enc->api.nvEncGetEncodePresetConfigEx(enc->encoder, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P1_GUID, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 8;
		out.nvstatus = status;
		strncpy(out.message, "nvEncGetEncodePresetConfigEx failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}
	preset.presetCfg.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
	preset.presetCfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
	preset.presetCfg.rcParams.averageBitRate = (uint32_t)bitrate;
	preset.presetCfg.rcParams.maxBitRate = (uint32_t)bitrate;
	preset.presetCfg.rcParams.vbvBufferSize = (uint32_t)(bitrate / fps);
	preset.presetCfg.rcParams.vbvInitialDelay = (uint32_t)(bitrate / fps);
	nvenc_configure_h264_stream(&preset.presetCfg, fps);

	NV_ENC_INITIALIZE_PARAMS init;
	memset(&init, 0, sizeof(init));
	init.version = NV_ENC_INITIALIZE_PARAMS_VER;
	init.encodeGUID = NV_ENC_CODEC_H264_GUID;
	init.presetGUID = NV_ENC_PRESET_P1_GUID;
	init.encodeWidth = (uint32_t)width;
	init.encodeHeight = (uint32_t)height;
	init.darWidth = (uint32_t)width;
	init.darHeight = (uint32_t)height;
	init.frameRateNum = (uint32_t)fps;
	init.frameRateDen = 1;
	init.enableEncodeAsync = 0;
	init.enablePTD = 1;
	init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
	init.encodeConfig = &preset.presetCfg;
	status = enc->api.nvEncInitializeEncoder(enc->encoder, &init);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 9;
		out.nvstatus = status;
		strncpy(out.message, "nvEncInitializeEncoder failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}

	D3D11_TEXTURE2D_DESC desc;
	memset(&desc, 0, sizeof(desc));
	desc.Width = (UINT)width;
	desc.Height = (UINT)height;
	desc.MipLevels = 1;
	desc.ArraySize = 1;
	desc.Format = DXGI_FORMAT_NV12;
	desc.SampleDesc.Count = 1;
	desc.Usage = D3D11_USAGE_DEFAULT;
	desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
	hr = enc->device->lpVtbl->CreateTexture2D(enc->device, &desc, NULL, &enc->texture);
	if (FAILED(hr)) {
		out.stage = 10;
		out.hr = hr;
		strncpy(out.message, "CreateTexture2D DXGI_FORMAT_NV12 failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}

	NV_ENC_REGISTER_RESOURCE reg;
	memset(&reg, 0, sizeof(reg));
	reg.version = NV_ENC_REGISTER_RESOURCE_VER;
	reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
	reg.width = (uint32_t)width;
	reg.height = (uint32_t)height;
	reg.pitch = 0;
	reg.resourceToRegister = enc->texture;
	reg.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
	reg.bufferUsage = NV_ENC_INPUT_IMAGE;
	status = enc->api.nvEncRegisterResource(enc->encoder, &reg);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 11;
		out.nvstatus = status;
		strncpy(out.message, "nvEncRegisterResource failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}
	enc->registered_resource = reg.registeredResource;

	NV_ENC_CREATE_BITSTREAM_BUFFER bs;
	memset(&bs, 0, sizeof(bs));
	bs.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
	status = enc->api.nvEncCreateBitstreamBuffer(enc->encoder, &bs);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 12;
		out.nvstatus = status;
		strncpy(out.message, "nvEncCreateBitstreamBuffer failed", sizeof(out.message)-1);
		nvenc_release_encoder(enc);
		return out;
	}
	enc->bitstream = bs.bitstreamBuffer;
	out.encoder = enc;
	return out;
}

static nvenc_d3d11_encode_result nvenc_encode_d3d11_nv12(nvenc_d3d11_encoder *enc, uint8_t *nv12, int nv12_len, int force_idr) {
	nvenc_d3d11_encode_result out;
	memset(&out, 0, sizeof(out));
	if (!enc || !nv12) {
		out.stage = 1;
		out.nvstatus = NV_ENC_ERR_INVALID_PTR;
		strncpy(out.message, "nil encoder or frame", sizeof(out.message)-1);
		return out;
	}
	int expected = enc->width * enc->height * 3 / 2;
	if (nv12_len < expected) {
		out.stage = 2;
		out.nvstatus = NV_ENC_ERR_INVALID_PARAM;
		strncpy(out.message, "NV12 frame is too small", sizeof(out.message)-1);
		return out;
	}

	enc->context->lpVtbl->UpdateSubresource(enc->context, (ID3D11Resource*)enc->texture, 0, NULL, nv12, (UINT)enc->width, (UINT)expected);
	NV_ENC_MAP_INPUT_RESOURCE map;
	memset(&map, 0, sizeof(map));
	map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
	map.registeredResource = enc->registered_resource;
	NVENCSTATUS status = enc->api.nvEncMapInputResource(enc->encoder, &map);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 3;
		out.nvstatus = status;
		strncpy(out.message, "nvEncMapInputResource failed", sizeof(out.message)-1);
		return out;
	}

	NV_ENC_PIC_PARAMS pic;
	memset(&pic, 0, sizeof(pic));
	pic.version = NV_ENC_PIC_PARAMS_VER;
	pic.inputWidth = (uint32_t)enc->width;
	pic.inputHeight = (uint32_t)enc->height;
	pic.inputPitch = (uint32_t)enc->width;
	pic.inputBuffer = map.mappedResource;
	pic.outputBitstream = enc->bitstream;
	pic.bufferFmt = map.mappedBufferFmt;
	pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
	pic.frameIdx = enc->frame++;
	if (force_idr) {
		pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR;
	}
	status = enc->api.nvEncEncodePicture(enc->encoder, &pic);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 4;
		out.nvstatus = status;
		strncpy(out.message, "nvEncEncodePicture failed", sizeof(out.message)-1);
		enc->api.nvEncUnmapInputResource(enc->encoder, map.mappedResource);
		return out;
	}

	NV_ENC_LOCK_BITSTREAM lock;
	memset(&lock, 0, sizeof(lock));
	lock.version = NV_ENC_LOCK_BITSTREAM_VER;
	lock.outputBitstream = enc->bitstream;
	lock.doNotWait = 0;
	status = enc->api.nvEncLockBitstream(enc->encoder, &lock);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 5;
		out.nvstatus = status;
		strncpy(out.message, "nvEncLockBitstream failed", sizeof(out.message)-1);
		enc->api.nvEncUnmapInputResource(enc->encoder, map.mappedResource);
		return out;
	}

	if (lock.bitstreamSizeInBytes > 0 && lock.bitstreamBufferPtr) {
		out.data = (uint8_t*)malloc(lock.bitstreamSizeInBytes);
		if (!out.data) {
			out.stage = 6;
			out.nvstatus = NV_ENC_ERR_OUT_OF_MEMORY;
			strncpy(out.message, "alloc output failed", sizeof(out.message)-1);
		} else {
			memcpy(out.data, lock.bitstreamBufferPtr, lock.bitstreamSizeInBytes);
			out.size = (int)lock.bitstreamSizeInBytes;
		}
	}
	status = enc->api.nvEncUnlockBitstream(enc->encoder, enc->bitstream);
	enc->api.nvEncUnmapInputResource(enc->encoder, map.mappedResource);
	if (status != NV_ENC_SUCCESS && out.stage == 0) {
		out.stage = 7;
		out.nvstatus = status;
		strncpy(out.message, "nvEncUnlockBitstream failed", sizeof(out.message)-1);
	}
	return out;
}

static nvenc_d3d11_encode_result nvenc_encode_d3d11_texture(nvenc_d3d11_texture_encoder *enc, ID3D11Texture2D *texture, int force_idr) {
	nvenc_d3d11_encode_result out;
	memset(&out, 0, sizeof(out));
	LARGE_INTEGER qpc_freq;
	LARGE_INTEGER t0;
	LARGE_INTEGER t1;
	QueryPerformanceFrequency(&qpc_freq);
	if (!enc || !texture) {
		out.stage = 1;
		out.nvstatus = NV_ENC_ERR_INVALID_PTR;
		strncpy(out.message, "nil encoder or texture", sizeof(out.message)-1);
		return out;
	}
	if (enc->use_video_processor && (!enc->video_context || !enc->video_processor)) {
		out.stage = 3;
		out.nvstatus = NV_ENC_ERR_INVALID_PTR;
		strncpy(out.message, "GPU BGRA->NV12 video processor is missing", sizeof(out.message)-1);
		return out;
	}
	int slot_i = enc->slot_index;
	nvenc_d3d11_texture_slot *slot = &enc->slots[slot_i];
	if (enc->pending_count >= NVENC_D3D11_TEXTURE_PIPELINE_DEPTH) {
		if (!slot->in_flight || !slot->mapped_resource || !slot->bitstream) {
			out.stage = 2;
			out.nvstatus = NV_ENC_ERR_INVALID_PTR;
			strncpy(out.message, "pipeline slot is not lockable", sizeof(out.message)-1);
			return out;
		}
		NV_ENC_LOCK_BITSTREAM lock;
		memset(&lock, 0, sizeof(lock));
		lock.version = NV_ENC_LOCK_BITSTREAM_VER;
		lock.outputBitstream = slot->bitstream;
		lock.doNotWait = 0;
		QueryPerformanceCounter(&t0);
		NVENCSTATUS status = enc->api.nvEncLockBitstream(enc->encoder, &lock);
		QueryPerformanceCounter(&t1);
		out.lock_ms = nvenc_qpc_ms(t0, t1, qpc_freq);
		if (status != NV_ENC_SUCCESS) {
			out.stage = 7;
			out.nvstatus = status;
			strncpy(out.message, "nvEncLockBitstream failed", sizeof(out.message)-1);
			return out;
		}
		if (lock.bitstreamSizeInBytes > 0 && lock.bitstreamBufferPtr) {
			out.data = (uint8_t*)malloc(lock.bitstreamSizeInBytes);
			if (!out.data) {
				out.stage = 8;
				out.nvstatus = NV_ENC_ERR_OUT_OF_MEMORY;
				strncpy(out.message, "alloc output failed", sizeof(out.message)-1);
			} else {
				memcpy(out.data, lock.bitstreamBufferPtr, lock.bitstreamSizeInBytes);
				out.size = (int)lock.bitstreamSizeInBytes;
			}
		}
		status = enc->api.nvEncUnlockBitstream(enc->encoder, slot->bitstream);
		NVENCSTATUS unmap_status = enc->api.nvEncUnmapInputResource(enc->encoder, slot->mapped_resource);
		slot->mapped_resource = NULL;
		slot->in_flight = 0;
		enc->pending_count--;
		if (status != NV_ENC_SUCCESS && out.stage == 0) {
			out.stage = 9;
			out.nvstatus = status;
			strncpy(out.message, "nvEncUnlockBitstream failed", sizeof(out.message)-1);
			return out;
		}
		if (unmap_status != NV_ENC_SUCCESS && out.stage == 0) {
			out.stage = 10;
			out.nvstatus = unmap_status;
			strncpy(out.message, "nvEncUnmapInputResource failed", sizeof(out.message)-1);
			return out;
		}
	}
	if (slot->in_flight || !slot->input_texture || !slot->registered_resource || !slot->bitstream) {
		out.stage = 2;
		out.nvstatus = NV_ENC_ERR_INVALID_PTR;
		strncpy(out.message, "pipeline slot is not ready for encode", sizeof(out.message)-1);
		return out;
	}
	if (enc->use_video_processor && (!slot->source_texture || !slot->video_input_view || !slot->video_output_view)) {
		out.stage = 2;
		out.nvstatus = NV_ENC_ERR_INVALID_PTR;
		strncpy(out.message, "video-processor pipeline slot is not ready for encode", sizeof(out.message)-1);
		return out;
	}
	QueryPerformanceCounter(&t0);
	enc->context->lpVtbl->CopyResource(enc->context, enc->use_video_processor ? (ID3D11Resource*)slot->source_texture : (ID3D11Resource*)slot->input_texture, (ID3D11Resource*)texture);
	QueryPerformanceCounter(&t1);
	out.copy_ms = nvenc_qpc_ms(t0, t1, qpc_freq);

	if (enc->use_video_processor) {
		RECT src_rect;
		src_rect.left = 0;
		src_rect.top = 0;
		src_rect.right = enc->input_width;
		src_rect.bottom = enc->input_height;
		RECT dst_rect;
		dst_rect.left = 0;
		dst_rect.top = 0;
		dst_rect.right = enc->encode_width;
		dst_rect.bottom = enc->encode_height;
		enc->video_context->lpVtbl->VideoProcessorSetStreamFrameFormat(enc->video_context, enc->video_processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
		nvenc_set_video_processor_color_space(enc);
		enc->video_context->lpVtbl->VideoProcessorSetStreamSourceRect(enc->video_context, enc->video_processor, 0, TRUE, &src_rect);
		enc->video_context->lpVtbl->VideoProcessorSetStreamDestRect(enc->video_context, enc->video_processor, 0, TRUE, &dst_rect);
		enc->video_context->lpVtbl->VideoProcessorSetOutputTargetRect(enc->video_context, enc->video_processor, TRUE, &dst_rect);
		enc->video_context->lpVtbl->VideoProcessorSetStreamAutoProcessingMode(enc->video_context, enc->video_processor, 0, FALSE);
		D3D11_VIDEO_PROCESSOR_STREAM stream;
		memset(&stream, 0, sizeof(stream));
		stream.Enable = TRUE;
		stream.OutputIndex = 0;
		stream.InputFrameOrField = 0;
		stream.pInputSurface = slot->video_input_view;
		QueryPerformanceCounter(&t0);
		HRESULT hr = enc->video_context->lpVtbl->VideoProcessorBlt(enc->video_context, enc->video_processor, slot->video_output_view, enc->frame, 1, &stream);
		QueryPerformanceCounter(&t1);
		out.blt_ms = nvenc_qpc_ms(t0, t1, qpc_freq);
		if (FAILED(hr)) {
			out.stage = 4;
			out.nvstatus = NV_ENC_ERR_GENERIC;
			snprintf(out.message, sizeof(out.message), "VideoProcessorBlt failed hr=0x%08lx", (unsigned long)hr);
			return out;
		}
	}

	NV_ENC_MAP_INPUT_RESOURCE map;
	memset(&map, 0, sizeof(map));
	map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
	map.registeredResource = slot->registered_resource;
	QueryPerformanceCounter(&t0);
	NVENCSTATUS status = enc->api.nvEncMapInputResource(enc->encoder, &map);
	QueryPerformanceCounter(&t1);
	out.map_ms = nvenc_qpc_ms(t0, t1, qpc_freq);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 5;
		out.nvstatus = status;
		strncpy(out.message, "nvEncMapInputResource failed", sizeof(out.message)-1);
		return out;
	}

	NV_ENC_PIC_PARAMS pic;
	memset(&pic, 0, sizeof(pic));
	pic.version = NV_ENC_PIC_PARAMS_VER;
	pic.inputWidth = (uint32_t)enc->encode_width;
	pic.inputHeight = (uint32_t)enc->encode_height;
	pic.inputPitch = (uint32_t)enc->encode_width;
	pic.inputBuffer = map.mappedResource;
	pic.outputBitstream = slot->bitstream;
	pic.bufferFmt = map.mappedBufferFmt;
	pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
	pic.frameIdx = enc->frame++;
	if (force_idr) {
		pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR;
	}
	QueryPerformanceCounter(&t0);
	status = enc->api.nvEncEncodePicture(enc->encoder, &pic);
	QueryPerformanceCounter(&t1);
	out.submit_ms = nvenc_qpc_ms(t0, t1, qpc_freq);
	if (status != NV_ENC_SUCCESS) {
		out.stage = 6;
		out.nvstatus = status;
		strncpy(out.message, "nvEncEncodePicture failed", sizeof(out.message)-1);
		enc->api.nvEncUnmapInputResource(enc->encoder, map.mappedResource);
		return out;
	}
	slot->mapped_resource = map.mappedResource;
	slot->in_flight = 1;
	enc->pending_count++;
	enc->slot_index = (slot_i + 1) % NVENC_D3D11_TEXTURE_PIPELINE_DEPTH;
	return out;
}

static void nvenc_fill_nv12_frame(uint8_t *buf, int width, int height, int frame) {
	uint8_t *y = buf;
	uint8_t *uv = buf + ((size_t)width * (size_t)height);
	for (int row = 0; row < height; row++) {
		for (int col = 0; col < width; col++) {
			y[(size_t)row * (size_t)width + (size_t)col] = (uint8_t)(16 + ((col + row + frame * 7) & 0xdf));
		}
	}
	for (int row = 0; row < height / 2; row++) {
		for (int col = 0; col < width; col += 2) {
			uv[(size_t)row * (size_t)width + (size_t)col] = (uint8_t)(96 + ((row + frame * 3) & 0x3f));
			uv[(size_t)row * (size_t)width + (size_t)col + 1] = (uint8_t)(128 + ((col + frame * 5) & 0x3f));
		}
	}
}

static nvenc_d3d11_smoke_result run_nvenc_d3d11_smoke_c(int width, int height, int fps, int frames, int bitrate) {
	nvenc_d3d11_smoke_result out;
	memset(&out, 0, sizeof(out));
	out.width = width;
	out.height = height;
	out.fps = fps;
	out.frames = frames;

	if (width <= 0 || height <= 0 || (width & 1) || (height & 1) || fps <= 0 || frames <= 0) {
		nvenc_fail_status(&out, 1, NV_ENC_ERR_INVALID_PARAM, "width/height/fps/frames must be positive, and width/height must be even");
		return out;
	}

	LARGE_INTEGER qpc_freq;
	QueryPerformanceFrequency(&qpc_freq);

	ID3D11Device *device = NULL;
	ID3D11DeviceContext *context = NULL;
	D3D_FEATURE_LEVEL got_level;
	D3D_FEATURE_LEVEL levels[] = {
		D3D_FEATURE_LEVEL_11_1,
		D3D_FEATURE_LEVEL_11_0,
		D3D_FEATURE_LEVEL_10_1,
		D3D_FEATURE_LEVEL_10_0,
	};
	HRESULT hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL,
		D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 4, D3D11_SDK_VERSION,
		&device, &got_level, &context);
	if (FAILED(hr)) {
		nvenc_fail_hr(&out, 2, hr, "D3D11CreateDevice failed");
		return out;
	}

	HMODULE dll = LoadLibraryA("nvEncodeAPI64.dll");
	if (!dll) {
		nvenc_fail_hr(&out, 3, HRESULT_FROM_WIN32(GetLastError()), "LoadLibrary nvEncodeAPI64.dll failed");
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}
	nvenc_create_instance_fn create_instance = (nvenc_create_instance_fn)GetProcAddress(dll, "NvEncodeAPICreateInstance");
	if (!create_instance) {
		nvenc_fail_hr(&out, 4, HRESULT_FROM_WIN32(GetLastError()), "NvEncodeAPICreateInstance not found");
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	NV_ENCODE_API_FUNCTION_LIST api;
	memset(&api, 0, sizeof(api));
	api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
	NVENCSTATUS status = create_instance(&api);
	if (status != NV_ENC_SUCCESS) {
		nvenc_fail_status(&out, 5, status, "NvEncodeAPICreateInstance failed");
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	void *encoder = NULL;
	NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open_params;
	memset(&open_params, 0, sizeof(open_params));
	open_params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
	open_params.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
	open_params.device = device;
	open_params.apiVersion = NVENCAPI_VERSION;
	status = api.nvEncOpenEncodeSessionEx(&open_params, &encoder);
	if (status != NV_ENC_SUCCESS) {
		nvenc_fail_status(&out, 6, status, "nvEncOpenEncodeSessionEx failed");
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	NV_ENC_PRESET_CONFIG preset;
	memset(&preset, 0, sizeof(preset));
	preset.version = NV_ENC_PRESET_CONFIG_VER;
	preset.presetCfg.version = NV_ENC_CONFIG_VER;
	status = api.nvEncGetEncodePresetConfigEx(encoder, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P1_GUID, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset);
	if (status != NV_ENC_SUCCESS) {
		nvenc_fail_status(&out, 7, status, "nvEncGetEncodePresetConfigEx failed");
		api.nvEncDestroyEncoder(encoder);
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	preset.presetCfg.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
	preset.presetCfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
	preset.presetCfg.rcParams.averageBitRate = (uint32_t)bitrate;
	preset.presetCfg.rcParams.maxBitRate = (uint32_t)bitrate;
	preset.presetCfg.rcParams.vbvBufferSize = (uint32_t)(bitrate / fps);
	preset.presetCfg.rcParams.vbvInitialDelay = (uint32_t)(bitrate / fps);
	nvenc_configure_h264_stream(&preset.presetCfg, fps);

	NV_ENC_INITIALIZE_PARAMS init;
	memset(&init, 0, sizeof(init));
	init.version = NV_ENC_INITIALIZE_PARAMS_VER;
	init.encodeGUID = NV_ENC_CODEC_H264_GUID;
	init.presetGUID = NV_ENC_PRESET_P1_GUID;
	init.encodeWidth = (uint32_t)width;
	init.encodeHeight = (uint32_t)height;
	init.darWidth = (uint32_t)width;
	init.darHeight = (uint32_t)height;
	init.frameRateNum = (uint32_t)fps;
	init.frameRateDen = 1;
	init.enableEncodeAsync = 0;
	init.enablePTD = 1;
	init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
	init.encodeConfig = &preset.presetCfg;
	status = api.nvEncInitializeEncoder(encoder, &init);
	if (status != NV_ENC_SUCCESS) {
		nvenc_fail_status(&out, 8, status, "nvEncInitializeEncoder failed");
		api.nvEncDestroyEncoder(encoder);
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	D3D11_TEXTURE2D_DESC desc;
	memset(&desc, 0, sizeof(desc));
	desc.Width = (UINT)width;
	desc.Height = (UINT)height;
	desc.MipLevels = 1;
	desc.ArraySize = 1;
	desc.Format = DXGI_FORMAT_NV12;
	desc.SampleDesc.Count = 1;
	desc.Usage = D3D11_USAGE_DEFAULT;
	desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
	ID3D11Texture2D *texture = NULL;
	hr = device->lpVtbl->CreateTexture2D(device, &desc, NULL, &texture);
	if (FAILED(hr)) {
		nvenc_fail_hr(&out, 9, hr, "CreateTexture2D DXGI_FORMAT_NV12 failed");
		api.nvEncDestroyEncoder(encoder);
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	uint8_t *framebuf = nvenc_alloc_nv12_frame(width, height);
	if (!framebuf) {
		nvenc_fail_status(&out, 10, NV_ENC_ERR_OUT_OF_MEMORY, "alloc NV12 frame failed");
		texture->lpVtbl->Release(texture);
		api.nvEncDestroyEncoder(encoder);
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	NV_ENC_REGISTER_RESOURCE reg;
	memset(&reg, 0, sizeof(reg));
	reg.version = NV_ENC_REGISTER_RESOURCE_VER;
	reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
	reg.width = (uint32_t)width;
	reg.height = (uint32_t)height;
	reg.pitch = 0;
	reg.resourceToRegister = texture;
	reg.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
	reg.bufferUsage = NV_ENC_INPUT_IMAGE;
	status = api.nvEncRegisterResource(encoder, &reg);
	if (status != NV_ENC_SUCCESS) {
		nvenc_fail_status(&out, 11, status, "nvEncRegisterResource failed");
		free(framebuf);
		texture->lpVtbl->Release(texture);
		api.nvEncDestroyEncoder(encoder);
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	NV_ENC_CREATE_BITSTREAM_BUFFER bs;
	memset(&bs, 0, sizeof(bs));
	bs.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
	status = api.nvEncCreateBitstreamBuffer(encoder, &bs);
	if (status != NV_ENC_SUCCESS) {
		nvenc_fail_status(&out, 12, status, "nvEncCreateBitstreamBuffer failed");
		api.nvEncUnregisterResource(encoder, reg.registeredResource);
		free(framebuf);
		texture->lpVtbl->Release(texture);
		api.nvEncDestroyEncoder(encoder);
		FreeLibrary(dll);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	double total_ms = 0.0;
	for (int i = 0; i < frames; i++) {
		nvenc_fill_nv12_frame(framebuf, width, height, i);
		context->lpVtbl->UpdateSubresource(context, (ID3D11Resource*)texture, 0, NULL, framebuf, (UINT)width, (UINT)(width * height * 3 / 2));

		NV_ENC_MAP_INPUT_RESOURCE map;
		memset(&map, 0, sizeof(map));
		map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
		map.registeredResource = reg.registeredResource;
		status = api.nvEncMapInputResource(encoder, &map);
		if (status != NV_ENC_SUCCESS) {
			nvenc_fail_status(&out, 13, status, "nvEncMapInputResource failed");
			break;
		}

		NV_ENC_PIC_PARAMS pic;
		memset(&pic, 0, sizeof(pic));
		pic.version = NV_ENC_PIC_PARAMS_VER;
		pic.inputWidth = (uint32_t)width;
		pic.inputHeight = (uint32_t)height;
		pic.inputPitch = (uint32_t)width;
		pic.inputBuffer = map.mappedResource;
		pic.outputBitstream = bs.bitstreamBuffer;
		pic.bufferFmt = map.mappedBufferFmt;
		pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
		pic.frameIdx = (uint32_t)i;
		if (i == 0) {
			pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR;
		}

		LARGE_INTEGER start, end;
		QueryPerformanceCounter(&start);
		status = api.nvEncEncodePicture(encoder, &pic);
		if (status != NV_ENC_SUCCESS) {
			nvenc_fail_status(&out, 14, status, "nvEncEncodePicture failed");
			api.nvEncUnmapInputResource(encoder, map.mappedResource);
			break;
		}

		NV_ENC_LOCK_BITSTREAM lock;
		memset(&lock, 0, sizeof(lock));
		lock.version = NV_ENC_LOCK_BITSTREAM_VER;
		lock.outputBitstream = bs.bitstreamBuffer;
		lock.doNotWait = 0;
		status = api.nvEncLockBitstream(encoder, &lock);
		QueryPerformanceCounter(&end);
		if (status != NV_ENC_SUCCESS) {
			nvenc_fail_status(&out, 15, status, "nvEncLockBitstream failed");
			api.nvEncUnmapInputResource(encoder, map.mappedResource);
			break;
		}
		double ms = nvenc_qpc_ms(start, end, qpc_freq);
		if (out.frames == frames && i == 0) {
			out.first_ms = ms;
		}
		total_ms += ms;
		out.total_bytes += (uint64_t)lock.bitstreamSizeInBytes;
		status = api.nvEncUnlockBitstream(encoder, bs.bitstreamBuffer);
		api.nvEncUnmapInputResource(encoder, map.mappedResource);
		if (status != NV_ENC_SUCCESS) {
			nvenc_fail_status(&out, 16, status, "nvEncUnlockBitstream failed");
			break;
		}
	}

	api.nvEncDestroyBitstreamBuffer(encoder, bs.bitstreamBuffer);
	api.nvEncUnregisterResource(encoder, reg.registeredResource);
	free(framebuf);
	texture->lpVtbl->Release(texture);
	api.nvEncDestroyEncoder(encoder);
	FreeLibrary(dll);
	context->lpVtbl->Release(context);
	device->lpVtbl->Release(device);

	if (out.stage == 0) {
		out.ok = 1;
		out.avg_ms = total_ms / (double)frames;
		nvenc_set_msg(&out, "ok");
	}
	return out;
}

static nvenc_d3d11_smoke_result run_nvenc_d3d11_texture_pipeline_smoke_c(int width, int height, int fps, int frames, int bitrate) {
	nvenc_d3d11_smoke_result out;
	memset(&out, 0, sizeof(out));
	out.width = width;
	out.height = height;
	out.fps = fps;
	out.frames = frames;

	if (width <= 0 || height <= 0 || (width & 1) || (height & 1) || fps <= 0 || frames <= 0) {
		nvenc_fail_status(&out, 1, NV_ENC_ERR_INVALID_PARAM, "width/height/fps/frames must be positive, and width/height must be even");
		return out;
	}

	LARGE_INTEGER qpc_freq;
	QueryPerformanceFrequency(&qpc_freq);

	ID3D11Device *device = NULL;
	ID3D11DeviceContext *context = NULL;
	D3D_FEATURE_LEVEL got_level;
	D3D_FEATURE_LEVEL levels[] = {
		D3D_FEATURE_LEVEL_11_1,
		D3D_FEATURE_LEVEL_11_0,
		D3D_FEATURE_LEVEL_10_1,
		D3D_FEATURE_LEVEL_10_0,
	};
	HRESULT hr = D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL,
		D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 4, D3D11_SDK_VERSION,
		&device, &got_level, &context);
	if (FAILED(hr)) {
		nvenc_fail_hr(&out, 2, hr, "D3D11CreateDevice failed");
		return out;
	}

	uint8_t *framebuf = nvenc_alloc_bgra_frame(width, height);
	if (!framebuf) {
		nvenc_fail_status(&out, 3, NV_ENC_ERR_OUT_OF_MEMORY, "alloc BGRA frame failed");
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	D3D11_TEXTURE2D_DESC desc;
	memset(&desc, 0, sizeof(desc));
	desc.Width = (UINT)width;
	desc.Height = (UINT)height;
	desc.MipLevels = 1;
	desc.ArraySize = 1;
	desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
	desc.SampleDesc.Count = 1;
	desc.Usage = D3D11_USAGE_DEFAULT;
	desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
	D3D11_SUBRESOURCE_DATA init_data;
	memset(&init_data, 0, sizeof(init_data));
	init_data.pSysMem = framebuf;
	init_data.SysMemPitch = (UINT)width * 4;
	init_data.SysMemSlicePitch = (UINT)((size_t)width * (size_t)height * 4);
	ID3D11Texture2D *texture = NULL;
	hr = device->lpVtbl->CreateTexture2D(device, &desc, &init_data, &texture);
	free(framebuf);
	if (FAILED(hr) || !texture) {
		nvenc_fail_hr(&out, 4, hr, "CreateTexture2D DXGI_FORMAT_B8G8R8A8_UNORM failed");
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	nvenc_d3d11_texture_create_result created = nvenc_create_d3d11_texture_encoder(device, width, height, width, height, fps, bitrate, NV_ENC_BUFFER_FORMAT_ARGB, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
	if (!created.encoder) {
		out.stage = 5;
		out.hr = created.hr;
		out.nvstatus = created.nvstatus;
		strncpy(out.message, created.message, sizeof(out.message)-1);
		texture->lpVtbl->Release(texture);
		context->lpVtbl->Release(context);
		device->lpVtbl->Release(device);
		return out;
	}

	double total_ms = 0.0;
	int attempts = 0;
	int max_attempts = frames + NVENC_D3D11_TEXTURE_PIPELINE_DEPTH;
	int encoded_frames = 0;
	while (encoded_frames < frames && attempts < max_attempts) {
		LARGE_INTEGER t0;
		LARGE_INTEGER t1;
		QueryPerformanceCounter(&t0);
		nvenc_d3d11_encode_result encoded = nvenc_encode_d3d11_texture(created.encoder, texture, attempts == 0);
		QueryPerformanceCounter(&t1);
		double ms = nvenc_qpc_ms(t0, t1, qpc_freq);
		attempts++;
		if (encoded.stage != 0) {
			out.stage = 6;
			out.nvstatus = encoded.nvstatus;
			strncpy(out.message, encoded.message, sizeof(out.message)-1);
			if (encoded.data) {
				free(encoded.data);
			}
			break;
		}
		if (encoded.size > 0 && encoded.data) {
			if (encoded_frames == 0) {
				out.first_ms = ms;
			}
			total_ms += ms;
			out.total_bytes += (uint64_t)encoded.size;
			encoded_frames++;
			free(encoded.data);
		}
	}

	nvenc_release_texture_encoder(created.encoder);
	texture->lpVtbl->Release(texture);
	context->lpVtbl->Release(context);
	device->lpVtbl->Release(device);

	if (out.stage == 0 && encoded_frames > 0) {
		out.ok = encoded_frames == frames;
		out.avg_ms = total_ms / (double)encoded_frames;
		if (out.ok) {
			nvenc_set_msg(&out, "ok");
		} else {
			nvenc_set_msg(&out, "pipeline produced fewer frames than requested");
		}
	}
	return out;
}
*/
import "C"

import (
	"fmt"
	"image"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"
)

type NVENCD3D11SmokeOptions struct {
	Width   int `json:"width"`
	Height  int `json:"height"`
	FPS     int `json:"fps"`
	Frames  int `json:"frames"`
	Bitrate int `json:"bitrate"`
}

type NVENCD3D11SmokeResult struct {
	OK         bool    `json:"ok"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	FPS        int     `json:"fps"`
	Frames     int     `json:"frames"`
	FirstMS    float64 `json:"first_ms"`
	AvgMS      float64 `json:"avg_ms"`
	TotalBytes uint64  `json:"total_bytes"`
	Error      string  `json:"error,omitempty"`
	Stage      int     `json:"stage,omitempty"`
	HRESULT    uint32  `json:"hresult,omitempty"`
	NVStatus   int     `json:"nv_status,omitempty"`
	Message    string  `json:"message,omitempty"`
}

func RunNVENCD3D11Smoke(opts NVENCD3D11SmokeOptions) NVENCD3D11SmokeResult {
	if opts.Width <= 0 {
		opts.Width = 1920
	}
	if opts.Height <= 0 {
		opts.Height = 1080
	}
	if opts.FPS <= 0 {
		opts.FPS = 60
	}
	if opts.Frames <= 0 {
		opts.Frames = 30
	}
	if opts.Bitrate <= 0 {
		opts.Bitrate = targetH264Bitrate(opts.Width, opts.Height, opts.FPS)
	}
	raw := C.run_nvenc_d3d11_texture_pipeline_smoke_c(C.int(opts.Width), C.int(opts.Height), C.int(opts.FPS), C.int(opts.Frames), C.int(opts.Bitrate))
	result := NVENCD3D11SmokeResult{
		OK:         raw.ok != 0,
		Width:      int(raw.width),
		Height:     int(raw.height),
		FPS:        int(raw.fps),
		Frames:     int(raw.frames),
		FirstMS:    float64(raw.first_ms),
		AvgMS:      float64(raw.avg_ms),
		TotalBytes: uint64(raw.total_bytes),
		Stage:      int(raw.stage),
		HRESULT:    uint32(raw.hr),
		NVStatus:   int(raw.nvstatus),
		Message:    C.GoString(&raw.message[0]),
	}
	if !result.OK {
		result.Error = result.Message
		if result.HRESULT != 0 {
			result.Error = fmt.Sprintf("%s hr=0x%x", result.Error, result.HRESULT)
		}
		if result.NVStatus != 0 {
			result.Error = fmt.Sprintf("%s nvstatus=%d", result.Error, result.NVStatus)
		}
	}
	return result
}

type nativeH264Encoder struct {
	enc          *C.nvenc_d3d11_encoder
	width        int
	height       int
	requestedFPS int
	fps          int
	frame        uint64
	scratch      []byte
}

func newNativeH264Encoder(stream string, width, height, fps int) (h264FrameEncoder, error) {
	bitrate := targetH264Bitrate(width, height, fps)
	raw := C.nvenc_create_d3d11_encoder(C.int(width), C.int(height), C.int(fps), C.int(bitrate))
	if raw.encoder == nil {
		return nil, formatNVENCCreateError(raw)
	}
	enc := &nativeH264Encoder{
		enc:          raw.encoder,
		width:        width,
		height:       height,
		requestedFPS: fps,
		fps:          fps,
	}
	log.Printf("capture: native NVENC D3D11 h264 encoder active stream=%s provider=NVIDIA NVENC size=%dx%d fps=%d input=NV12(upload) bitrate=%d", stream, width, height, fps, bitrate)
	return enc, nil
}

func nativeH264AvailabilityDetail() string {
	probe := RunNVENCSmoke()
	if probe.Available {
		return fmt.Sprintf("NVIDIA NVENC available through %s api=%d.%d", probe.DLL, probe.APIMajor, probe.APIMinor)
	}
	return ""
}

func (e *nativeH264Encoder) Matches(width, height, fps int) bool {
	return e != nil && e.enc != nil && e.width == width && e.height == height && e.requestedFPS == fps
}

func (e *nativeH264Encoder) Close() {
	if e != nil && e.enc != nil {
		C.nvenc_release_encoder(e.enc)
		e.enc = nil
	}
}

func (e *nativeH264Encoder) Encode(img *image.RGBA) ([]byte, error) {
	nv12Len := e.width*e.height + (e.width*e.height)/2
	if cap(e.scratch) < nv12Len {
		e.scratch = make([]byte, nv12Len)
	} else {
		e.scratch = e.scratch[:nv12Len]
	}
	rgbaToNV12(img, e.scratch, e.width, e.height)
	forceIDR := 0
	if e.frame == 0 {
		forceIDR = 1
	}
	raw := C.nvenc_encode_d3d11_nv12(e.enc, (*C.uint8_t)(unsafe.Pointer(&e.scratch[0])), C.int(len(e.scratch)), C.int(forceIDR))
	e.frame++
	if raw.stage != 0 {
		if raw.data != nil {
			C.free(unsafe.Pointer(raw.data))
		}
		return nil, formatNVENCEncodeError(raw)
	}
	if raw.size == 0 || raw.data == nil {
		return nil, nil
	}
	defer C.free(unsafe.Pointer(raw.data))
	return C.GoBytes(unsafe.Pointer(raw.data), C.int(raw.size)), nil
}

func formatNVENCCreateError(raw C.nvenc_d3d11_create_result) error {
	msg := C.GoString(&raw.message[0])
	if msg == "" {
		msg = "NVENC D3D11 encoder create failed"
	}
	if raw.hr != 0 {
		return fmt.Errorf("%s stage=%d hr=0x%x", msg, int(raw.stage), uint32(raw.hr))
	}
	if raw.nvstatus != 0 {
		return fmt.Errorf("%s stage=%d nvstatus=%d", msg, int(raw.stage), int(raw.nvstatus))
	}
	return fmt.Errorf("%s stage=%d", msg, int(raw.stage))
}

func formatNVENCEncodeError(raw C.nvenc_d3d11_encode_result) error {
	msg := C.GoString(&raw.message[0])
	if msg == "" {
		msg = "NVENC D3D11 encode failed"
	}
	if raw.nvstatus != 0 {
		return fmt.Errorf("%s stage=%d nvstatus=%d", msg, int(raw.stage), int(raw.nvstatus))
	}
	return fmt.Errorf("%s stage=%d", msg, int(raw.stage))
}

type nativeD3D11TextureH264Encoder struct {
	enc          *C.nvenc_d3d11_texture_encoder
	device       unsafe.Pointer
	inputWidth   int
	inputHeight  int
	encodeWidth  int
	encodeHeight int
	requestedFPS int
	dxgiFormat   uint32
	bufferFormat uint32
	outputMode   int
	outputName   string
	frame        uint64
	slowLogs     int
}

func newNativeD3D11TextureH264Encoder(device unsafe.Pointer, inputWidth, inputHeight, encodeWidth, encodeHeight, fps int, dxgiFormat uint32) (*nativeD3D11TextureH264Encoder, error) {
	bufferFormat, name, ok := nvencBufferFormatForDXGI(dxgiFormat)
	if !ok {
		return nil, fmt.Errorf("unsupported DXGI texture format %d", dxgiFormat)
	}
	bitrate := targetH264Bitrate(encodeWidth, encodeHeight, fps)
	modes := preferredNVENCD3D11OutputModes()
	var lastErr error
	var raw C.nvenc_d3d11_texture_create_result
	outputMode := 0
	outputName := ""
	for _, mode := range modes {
		raw = C.nvenc_create_d3d11_texture_encoder(
			(*C.ID3D11Device)(device),
			C.int(inputWidth),
			C.int(inputHeight),
			C.int(encodeWidth),
			C.int(encodeHeight),
			C.int(fps),
			C.int(bitrate),
			C.NV_ENC_BUFFER_FORMAT(bufferFormat),
			C.int(dxgiFormat),
			C.int(mode),
		)
		if raw.encoder != nil {
			outputMode = mode
			outputName = nvencD3D11OutputModeName(mode)
			break
		}
		lastErr = formatNVENCTextureCreateError(raw)
		if len(modes) > 1 {
			log.Printf("capture: native NVENC D3D11 desktop texture encoder output=%s unavailable: %v", nvencD3D11OutputModeName(mode), lastErr)
		}
	}
	if raw.encoder == nil {
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, fmt.Errorf("NVENC D3D11 texture encoder create failed")
	}
	pipeline := "d3d11_video_processor"
	if outputMode == 1 && inputWidth == encodeWidth && inputHeight == encodeHeight {
		pipeline = "d3d11_direct_copy"
	}
	enc := &nativeD3D11TextureH264Encoder{
		enc:          raw.encoder,
		device:       device,
		inputWidth:   inputWidth,
		inputHeight:  inputHeight,
		encodeWidth:  encodeWidth,
		encodeHeight: encodeHeight,
		requestedFPS: fps,
		dxgiFormat:   dxgiFormat,
		bufferFormat: uint32(bufferFormat),
		outputMode:   outputMode,
		outputName:   outputName,
	}
	if inputWidth != encodeWidth || inputHeight != encodeHeight {
		log.Printf("capture: native NVENC D3D11 desktop texture encoder active provider=NVIDIA NVENC input=%dx%d output=%dx%d fps=%d source_format=%s(dxgi=%d) nvenc_input=%s pipeline=%s bitrate=%d", inputWidth, inputHeight, encodeWidth, encodeHeight, fps, name, dxgiFormat, outputName, pipeline, bitrate)
	} else {
		log.Printf("capture: native NVENC D3D11 desktop texture encoder active provider=NVIDIA NVENC size=%dx%d fps=%d source_format=%s(dxgi=%d) nvenc_input=%s pipeline=%s bitrate=%d", encodeWidth, encodeHeight, fps, name, dxgiFormat, outputName, pipeline, bitrate)
	}
	return enc, nil
}

func (e *nativeD3D11TextureH264Encoder) Matches(device unsafe.Pointer, inputWidth, inputHeight, encodeWidth, encodeHeight, fps int, dxgiFormat uint32) bool {
	return e != nil && e.enc != nil && e.device == device && e.inputWidth == inputWidth && e.inputHeight == inputHeight && e.encodeWidth == encodeWidth && e.encodeHeight == encodeHeight && e.requestedFPS == fps && e.dxgiFormat == dxgiFormat && nvencD3D11OutputModeAllowed(e.outputMode)
}

func (e *nativeD3D11TextureH264Encoder) Close() {
	if e != nil && e.enc != nil {
		C.nvenc_release_texture_encoder(e.enc)
		e.enc = nil
	}
}

func (e *nativeD3D11TextureH264Encoder) EncodeTexture(texture unsafe.Pointer, forceIDR bool) ([]byte, error) {
	if e == nil || e.enc == nil {
		return nil, fmt.Errorf("nil NVENC D3D11 texture encoder")
	}
	force := 0
	if forceIDR || e.frame == 0 {
		force = 1
	}
	frame := e.frame
	raw := C.nvenc_encode_d3d11_texture(e.enc, (*C.ID3D11Texture2D)(texture), C.int(force))
	e.frame++
	e.maybeLogEncodeDetail(raw, frame, forceIDR)
	if raw.stage != 0 {
		if raw.data != nil {
			C.free(unsafe.Pointer(raw.data))
		}
		return nil, formatNVENCEncodeError(raw)
	}
	if raw.size == 0 || raw.data == nil {
		return nil, nil
	}
	defer C.free(unsafe.Pointer(raw.data))
	return C.GoBytes(unsafe.Pointer(raw.data), C.int(raw.size)), nil
}

func (e *nativeD3D11TextureH264Encoder) maybeLogEncodeDetail(raw C.nvenc_d3d11_encode_result, frame uint64, forceIDR bool) {
	total := float64(raw.copy_ms + raw.blt_ms + raw.map_ms + raw.submit_ms + raw.lock_ms)
	traceMode := strings.ToLower(strings.TrimSpace(os.Getenv("OVERLORD_NVENC_D3D11_TRACE")))
	verbose := traceMode == "all" || traceMode == "verbose"
	traceSlow := traceMode == "1" || traceMode == "true" || traceMode == "yes" || traceMode == "on" || traceMode == "slow"
	if !verbose && !traceSlow && raw.stage == 0 {
		return
	}
	if !verbose && total < 20 && raw.stage == 0 {
		return
	}
	if !verbose && e.slowLogs >= 12 {
		return
	}
	e.slowLogs++
	stage := int(raw.stage)
	errText := ""
	if stage != 0 {
		errText = " error=" + C.GoString(&raw.message[0])
	}
	log.Printf("capture: NVENC D3D11 texture encode detail frame=%d output=%s force_idr=%t bytes=%d stage=%d total=%.2fms copy=%.2fms blt=%.2fms map=%.2fms submit=%.2fms lock=%.2fms%s",
		frame, e.outputName, forceIDR || frame == 0, int(raw.size), stage, total,
		float64(raw.copy_ms), float64(raw.blt_ms), float64(raw.map_ms), float64(raw.submit_ms), float64(raw.lock_ms), errText)
}

func formatNVENCTextureCreateError(raw C.nvenc_d3d11_texture_create_result) error {
	msg := C.GoString(&raw.message[0])
	if msg == "" {
		msg = "NVENC D3D11 texture encoder create failed"
	}
	if raw.hr != 0 {
		return fmt.Errorf("%s stage=%d hr=0x%x", msg, int(raw.stage), uint32(raw.hr))
	}
	if raw.nvstatus != 0 {
		return fmt.Errorf("%s stage=%d nvstatus=%d", msg, int(raw.stage), int(raw.nvstatus))
	}
	return fmt.Errorf("%s stage=%d", msg, int(raw.stage))
}

func nvencBufferFormatForDXGI(dxgiFormat uint32) (C.NV_ENC_BUFFER_FORMAT, string, bool) {
	switch dxgiFormat {
	case 87:
		return C.NV_ENC_BUFFER_FORMAT_ARGB, "ARGB/BGRA", true
	case 28:
		return C.NV_ENC_BUFFER_FORMAT_ABGR, "ABGR/RGBA", true
	default:
		return C.NV_ENC_BUFFER_FORMAT_UNDEFINED, "", false
	}
}

func preferredNVENCD3D11OutputModes() []int {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OVERLORD_NVENC_D3D11_OUTPUT"))) {
	case "nv12":
		return []int{0}
	case "bgra", "argb":
		return []int{1}
	default:
		return []int{1, 0}
	}
}

func nvencD3D11OutputModeAllowed(mode int) bool {
	for _, candidate := range preferredNVENCD3D11OutputModes() {
		if candidate == mode {
			return true
		}
	}
	return false
}

func nvencD3D11OutputModeName(mode int) string {
	if mode == 1 {
		return "ARGB/BGRA"
	}
	return "NV12"
}

func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

var (
	nativeTextureH264Mu       sync.Mutex
	nativeTextureH264Enc      *nativeD3D11TextureH264Encoder
	nativeTextureH264ForceIDR atomic.Bool
)

func encodeNativeH264D3D11Texture(device, texture unsafe.Pointer, inputWidth, inputHeight, encodeWidth, encodeHeight, fps int, dxgiFormat uint32, forceIDR bool) ([]byte, error) {
	if device == nil || texture == nil {
		return nil, fmt.Errorf("nil D3D11 device or texture")
	}
	nativeTextureH264Mu.Lock()
	defer nativeTextureH264Mu.Unlock()

	if nativeTextureH264Enc == nil || !nativeTextureH264Enc.Matches(device, inputWidth, inputHeight, encodeWidth, encodeHeight, fps, dxgiFormat) {
		if nativeTextureH264Enc != nil {
			nativeTextureH264Enc.Close()
			nativeTextureH264Enc = nil
		}
		enc, err := newNativeD3D11TextureH264Encoder(device, inputWidth, inputHeight, encodeWidth, encodeHeight, fps, dxgiFormat)
		if err != nil {
			return nil, err
		}
		nativeTextureH264Enc = enc
	}
	return nativeTextureH264Enc.EncodeTexture(texture, forceIDR || nativeTextureH264ForceIDR.Swap(false))
}

func requestNativeH264D3D11TextureKeyframe() {
	nativeTextureH264ForceIDR.Store(true)
}

func resetNativeH264D3D11TextureEncoder() {
	nativeTextureH264Mu.Lock()
	defer nativeTextureH264Mu.Unlock()
	if nativeTextureH264Enc != nil {
		nativeTextureH264Enc.Close()
		nativeTextureH264Enc = nil
	}
	nativeTextureH264ForceIDR.Store(false)
}
