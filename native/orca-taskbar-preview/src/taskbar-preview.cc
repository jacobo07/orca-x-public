// Windows taskbar iconic representation for an Orca window.
//
// Windows has supplied live taskbar thumbnails since Windows 7, but every call below documents
// "this window must belong to the calling process" -- which is why this is an in-process addon and
// not one of Orca's existing out-of-process Windows helpers. Knowing a window handle is not the
// same as owning the native operation.
//
// The split this file is on the far side of: the caller owns *what* the thumbnail is about (which
// window, which pane, which terminal, which generation of its screen) and this file owns only *how
// that becomes pixels at the size Windows asked for*. Nothing here parses terminal output, resolves
// a pane, or decides when to refresh. Output dimensions requested by the shell constrain the image
// returned to the shell and nothing else -- they must never reach a PTY.
//
// Message numbers come from <dwmapi.h> at compile time rather than being typed in, so they cannot
// drift from the SDK.
#include <node_api.h>
#include <windows.h>
#include <dwmapi.h>

#include <string>
#include <vector>

namespace {

// Measured, not read: DWM accepts a 32bpp top-down DIB with opaque alpha, and accepts it up to at
// least a third of a second after the window procedure returned. The second half is what lets the
// caller rasterize off the message path instead of keeping a pre-rendered frame cache warm.
constexpr int kMaxThumbnailEdge = 4096;

HWND HwndFromBuffer(napi_env env, napi_value value) {
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok) {
    return nullptr;
  }
  if (length < sizeof(HWND)) {
    return nullptr;
  }
  return *reinterpret_cast<HWND*>(data);
}

napi_value MakeInt32(napi_env env, int32_t value) {
  napi_value result;
  napi_create_int32(env, value, &result);
  return result;
}

bool ReadInt32Property(napi_env env, napi_value object, const char* name, int32_t* out) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) {
    return false;
  }
  return napi_get_value_int32(env, value, out) == napi_ok;
}

bool ReadBoolProperty(napi_env env, napi_value object, const char* name, bool fallback) {
  napi_value value;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_boolean) {
    return fallback;
  }
  bool result = fallback;
  napi_get_value_bool(env, value, &result);
  return result;
}

std::wstring ReadStringProperty(napi_env env, napi_value object, const char* name) {
  napi_value value;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    return std::wstring();
  }
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) {
    return std::wstring();
  }
  std::wstring text(length, L'\0');
  size_t written = 0;
  napi_get_value_string_utf16(env, value, reinterpret_cast<char16_t*>(&text[0]), length + 1,
                              &written);
  text.resize(written);
  return text;
}

std::vector<std::wstring> ReadLines(napi_env env, napi_value object) {
  std::vector<std::wstring> lines;
  napi_value value;
  bool isArray = false;
  if (napi_get_named_property(env, object, "lines", &value) != napi_ok ||
      napi_is_array(env, value, &isArray) != napi_ok || !isArray) {
    return lines;
  }
  uint32_t count = 0;
  napi_get_array_length(env, value, &count);
  lines.reserve(count);
  for (uint32_t index = 0; index < count; index += 1) {
    napi_value element;
    if (napi_get_element(env, value, index, &element) != napi_ok) {
      lines.emplace_back();
      continue;
    }
    size_t length = 0;
    if (napi_get_value_string_utf16(env, element, nullptr, 0, &length) != napi_ok) {
      lines.emplace_back();
      continue;
    }
    std::wstring text(length, L'\0');
    size_t written = 0;
    napi_get_value_string_utf16(env, element, reinterpret_cast<char16_t*>(&text[0]), length + 1,
                               &written);
    text.resize(written);
    lines.push_back(std::move(text));
  }
  return lines;
}

/** JS speaks 0xRRGGBB because that is what a theme token looks like; GDI wants 0x00BBGGRR. */
COLORREF ToColorRef(int32_t rgb) {
  const uint32_t value = static_cast<uint32_t>(rgb);
  return RGB((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF);
}

/**
 * GDI text and fill operations do not write the alpha byte of a 32bpp DIB, so a freshly drawn
 * surface is fully transparent as far as DWM is concerned and the thumbnail comes back invisible.
 * Opaque alpha is what the delivery probe proved DWM accepts, so stamp it after drawing.
 */
void MakeOpaque(void* bits, int width, int height) {
  uint8_t* bytes = static_cast<uint8_t*>(bits);
  const size_t pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
  for (size_t index = 0; index < pixels; index += 1) {
    bytes[index * 4 + 3] = 0xFF;
  }
}

// Opt the window in. Without this DWM never sends a demand at all -- which is why a listen-only
// experiment on an un-opted-in window reports a working platform as a broken one.
napi_value EnableIconicRepresentation(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HWND hwnd = argc > 0 ? HwndFromBuffer(env, argv[0]) : nullptr;
  if (hwnd == nullptr) {
    return MakeInt32(env, static_cast<int32_t>(E_HANDLE));
  }

  // Forcing the iconic representation is what makes Windows ask us even when it could have
  // composed a thumbnail from the window's own (stale, minimized) surface.
  bool forceIconic = true;
  if (argc > 1) {
    napi_get_value_bool(env, argv[1], &forceIconic);
  }

  BOOL enabled = TRUE;
  HRESULT hasBitmap =
      DwmSetWindowAttribute(hwnd, DWMWA_HAS_ICONIC_BITMAP, &enabled, sizeof(enabled));
  HRESULT forced = S_OK;
  if (forceIconic) {
    forced =
        DwmSetWindowAttribute(hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, &enabled, sizeof(enabled));
  }
  return MakeInt32(env, static_cast<int32_t>(FAILED(hasBitmap) ? hasBitmap : forced));
}

/** Hands the window back to DWM's own compositing. Called on restore and before teardown. */
napi_value DisableIconicRepresentation(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HWND hwnd = argc > 0 ? HwndFromBuffer(env, argv[0]) : nullptr;
  if (hwnd == nullptr) {
    return MakeInt32(env, static_cast<int32_t>(E_HANDLE));
  }
  BOOL disabled = FALSE;
  HRESULT hasBitmap =
      DwmSetWindowAttribute(hwnd, DWMWA_HAS_ICONIC_BITMAP, &disabled, sizeof(disabled));
  HRESULT forced =
      DwmSetWindowAttribute(hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, &disabled, sizeof(disabled));
  return MakeInt32(env, static_cast<int32_t>(FAILED(hasBitmap) ? hasBitmap : forced));
}

/**
 * Tell the shell the representation it holds is out of date.
 *
 * Advisory by contract: the shell decides when, or whether, to ask again. So a successful return
 * here establishes that Windows accepted the hint, never that a user saw a newer frame.
 */
napi_value InvalidateIconicBitmaps(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HWND hwnd = argc > 0 ? HwndFromBuffer(env, argv[0]) : nullptr;
  if (hwnd == nullptr) {
    return MakeInt32(env, static_cast<int32_t>(E_HANDLE));
  }
  return MakeInt32(env, static_cast<int32_t>(DwmInvalidateIconicBitmaps(hwnd)));
}

/**
 * Draw the supplied rows at the supplied size and hand the result to DWM.
 *
 * Args: (hwndBuffer, { width, height, lines, background, foreground, livePreview })
 *
 * Row count decides legibility, and the caller decides the row count -- this only guarantees that
 * whatever it is given fits inside the height Windows asked for.
 */
napi_value DrawIconicText(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) {
    return MakeInt32(env, static_cast<int32_t>(E_INVALIDARG));
  }

  HWND hwnd = HwndFromBuffer(env, argv[0]);
  int32_t width = 0;
  int32_t height = 0;
  if (hwnd == nullptr || !ReadInt32Property(env, argv[1], "width", &width) ||
      !ReadInt32Property(env, argv[1], "height", &height) || width <= 0 || height <= 0 ||
      width > kMaxThumbnailEdge || height > kMaxThumbnailEdge) {
    return MakeInt32(env, static_cast<int32_t>(E_INVALIDARG));
  }

  int32_t background = 0x101010;
  int32_t foreground = 0xD0D0D0;
  ReadInt32Property(env, argv[1], "background", &background);
  ReadInt32Property(env, argv[1], "foreground", &foreground);
  const bool livePreview = ReadBoolProperty(env, argv[1], "livePreview", false);
  const std::vector<std::wstring> lines = ReadLines(env, argv[1]);
  std::wstring fontFace = ReadStringProperty(env, argv[1], "fontFace");
  if (fontFace.empty()) {
    fontFace = L"Consolas";
  }

  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = width;
  bmi.bmiHeader.biHeight = -height;  // negative => top-down rows, matching every producer upstream
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;

  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (bitmap == nullptr || bits == nullptr) {
    if (bitmap != nullptr) {
      DeleteObject(bitmap);
    }
    return MakeInt32(env, static_cast<int32_t>(E_OUTOFMEMORY));
  }

  HDC dc = CreateCompatibleDC(nullptr);
  if (dc == nullptr) {
    DeleteObject(bitmap);
    return MakeInt32(env, static_cast<int32_t>(E_OUTOFMEMORY));
  }
  HGDIOBJ previousBitmap = SelectObject(dc, bitmap);

  RECT surface = {0, 0, width, height};
  HBRUSH backgroundBrush = CreateSolidBrush(ToColorRef(background));
  FillRect(dc, &surface, backgroundBrush);
  DeleteObject(backgroundBrush);

  if (!lines.empty()) {
    const int padding = width >= 64 ? 3 : 0;
    const int usableHeight = height - padding * 2;
    int rowHeight = usableHeight / static_cast<int>(lines.size());
    if (rowHeight < 1) {
      rowHeight = 1;
    }
    // Leave a little leading so descenders do not collide with the row below.
    int glyphHeight = rowHeight - (rowHeight >= 8 ? 1 : 0);
    if (glyphHeight < 1) {
      glyphHeight = 1;
    }

    HFONT font = CreateFontW(-glyphHeight, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, FIXED_PITCH | FF_MODERN, fontFace.c_str());
    HGDIOBJ previousFont = font != nullptr ? SelectObject(dc, font) : nullptr;
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, ToColorRef(foreground));

    int y = padding;
    for (const std::wstring& line : lines) {
      if (y >= height) {
        break;
      }
      if (!line.empty()) {
        // Clipped to the surface rather than wrapped: a wrapped thumbnail row would show content
        // the terminal never placed on that line.
        RECT rowRect = {padding, y, width - padding, y + rowHeight};
        DrawTextW(dc, line.c_str(), static_cast<int>(line.size()), &rowRect,
                  DT_LEFT | DT_TOP | DT_SINGLELINE | DT_NOPREFIX);
      }
      y += rowHeight;
    }

    if (font != nullptr) {
      SelectObject(dc, previousFont);
      DeleteObject(font);
    }
  }

  // Flush GDI before reading the DIB bits back; without this the alpha stamp can race the drawing.
  GdiFlush();
  MakeOpaque(bits, width, height);

  SelectObject(dc, previousBitmap);
  DeleteDC(dc);

  HRESULT hr = livePreview ? DwmSetIconicLivePreviewBitmap(hwnd, bitmap, nullptr, 0)
                           : DwmSetIconicThumbnail(hwnd, bitmap, 0);

  // DWM copies what it accepts, so this bitmap is ours to release. Left alive it leaks once per
  // demand, and demands recur for the life of the window.
  DeleteObject(bitmap);
  return MakeInt32(env, static_cast<int32_t>(hr));
}

void SetNamedInt(napi_env env, napi_value target, const char* name, uint32_t value) {
  napi_value number;
  napi_create_uint32(env, value, &number);
  napi_set_named_property(env, target, name, number);
}

void SetNamedFn(napi_env env, napi_value target, const char* name, napi_callback callback) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &fn);
  napi_set_named_property(env, target, name, fn);
}

napi_value Init(napi_env env, napi_value exports) {
  // Exported rather than written down on the JS side so the two halves cannot disagree about which
  // message means what.
  napi_value messages;
  napi_create_object(env, &messages);
  SetNamedInt(env, messages, "sendIconicThumbnail", WM_DWMSENDICONICTHUMBNAIL);
  SetNamedInt(env, messages, "sendIconicLivePreviewBitmap", WM_DWMSENDICONICLIVEPREVIEWBITMAP);
  napi_set_named_property(env, exports, "messages", messages);

  SetNamedFn(env, exports, "enableIconicRepresentation", EnableIconicRepresentation);
  SetNamedFn(env, exports, "disableIconicRepresentation", DisableIconicRepresentation);
  SetNamedFn(env, exports, "invalidateIconicBitmaps", InvalidateIconicBitmaps);
  SetNamedFn(env, exports, "drawIconicText", DrawIconicText);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
