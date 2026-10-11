// ============================================================================
// RdpHostNative.cpp —— 浮灵饰界「桌面分身」原生 Win32 宿主
// ----------------------------------------------------------------------------
// 目标：以纯 Win32 + COM 复刻原 C# 宿主（RdpHost.Host）的核心效果，不依赖
// .NET / WinUI3，体积小。
//   核心能力：
//   1) 命令行参数与主程序（desktopSession.js）完全对齐；
//   2) 无边框悬浮预览小窗（280 宽）/ 独立大窗（1024 宽）两态切换，同一 RDP 连接不断；
//   3) 自绘毛玻璃标题栏 + DWM 圆角/暗色，边缘缩放，PerMonitorV2 DPI；
//   4) RDP ActiveX（MSTSC，CLSID A0C63C30-...）OLE 就地激活托管，连接 WTS Child Session；
//   5) 状态机写 _status.txt：connecting → HWND n → closed / failed|...；
//   6) TCP 输入注入服务（SendMouseEvent / SendKeyboardEvent），端口写 _input_port.txt；
//   7) 轮询 stop/theme 文件、父进程 PID 看门狗、owner 窗口绑定。
// 构建：vcvars64.bat && cl /EHsc /std:c++17 本文件 链接 winmm user32 gdi32 dwmapi
//       ole32 oleaut32 ws2_32
// ============================================================================
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <uxtheme.h>   // MARGINS（DwmExtendFrameIntoClientArea 用）
#include <ole2.h>
#include <oaidl.h>
#include <ocidl.h>
#include <olectl.h>
#include <gdiplus.h>
#include <winsock2.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <functional>
#include <chrono>
#include <cstdio>
#include <cstdarg>
#include <cwchar>
#include <cstdlib>
#include <map>
#include <unordered_map>
#include "resource.h"
#include <algorithm>
#include <fstream>
#include <sstream>
#include <cmath>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "winmm.lib")

// ============================================================================
// 常量（与 C# HostForm / desktopSession.js 对齐）
// ============================================================================
namespace Cfg {
    constexpr int TitlebarH      = 32;      // 大窗标题栏高（逻辑像素，DPI 缩放：150%→48 物理像素）
    constexpr int SmallW         = 280;     // 悬浮预览小窗内容宽
    constexpr int LargeW         = 1024;    // 独立大窗内容宽
    constexpr int SmallH         = 158;     // 280 * 720/1280（无标题栏）
    constexpr int AnchorGap      = 10;
    constexpr int CornerRadius   = 8;       // 逻辑圆角（DPI 换算）
    constexpr int DesktopW       = 1280;
    constexpr int DesktopH       = 720;
    constexpr int HintW          = 40;      // 中央"点击打开"毛玻璃胶囊（逻辑像素）
    constexpr int HintH          = 24;
}
// 注：HTCLIENT/HTCAPTION/HTLEFT..HTBOTTOMRIGHT、WS_THICKFRAME/WS_POPUP、
// WS_EX_TOOLWINDOW/WS_EX_NOACTIVATE/WS_EX_APPWINDOW 均为 Windows 头文件已定义的宏，
// 值与之相同，直接用系统宏，不再在 Cfg 中重定义（避免宏展开成"constexpr int 1=1"报错）。

// RDP ActiveX CLSID / 事件接口（MSTSC 官方 GUID）
const CLSID CLSID_MsRdpClient = {0xA0C63C30,0xF08D,0x4AB4,{0x90,0x7C,0x34,0x90,0x5D,0x77,0x0C,0x7D}};
const IID   IID_IMsRdpExtendedSettings = {0x302D8188,0x0052,0x4807,{0x80,0x6A,0x36,0x2B,0x62,0x8F,0x9A,0xC5}};
const IID   IID_IMsTscAxEvents = {0x336D5562,0xEFA8,0x482E,{0x8C,0xB3,0xC5,0xC0,0xFC,0x7A,0x7D,0xB6}};

// ============================================================================
// 日志
// ============================================================================
static std::wstring g_logPath;
static void log(const char* fmt, ...) {
    if (g_logPath.empty()) return;
    char buf[2048];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
    FILE* f = _wfopen(g_logPath.c_str(), L"ab");   // 追加二进制，写 UTF-8 字节
    if (f) { fwrite(buf, 1, strlen(buf), f); fwrite("\r\n", 1, 2, f); fclose(f); }
}
static std::wstring computeLogPath(const std::wstring& baseDir) {
    std::wstring b(baseDir);
    std::wstring l = b + L"\\_host_log.txt";
    // 打包态（app.asar.unpacked 只读）写临时目录
    if (b.find(L"app.asar.unpacked") != std::wstring::npos) {
        wchar_t tmp[MAX_PATH]; GetTempPathW(MAX_PATH, tmp);
        std::wstring d = std::wstring(tmp) + L"fuling-rdp-clone";
        CreateDirectoryW(d.c_str(), nullptr);
        return d + L"\\_host_log.txt";
    }
    return l;
}

// ============================================================================
// IDispatch 后期绑定助手（复刻 C# InvokeMember 反射式 COM 调用）
// ============================================================================
static bool DispGet(IDispatch* d, const wchar_t* name, VARIANT* out) {
    if (!d) return false;
    DISPID id; OLECHAR* n = const_cast<OLECHAR*>(name);
    if (FAILED(d->GetIDsOfNames(IID_NULL, &n, 1, LOCALE_USER_DEFAULT, &id))) return false;
    VARIANTARG arg; VariantInit(&arg);
    DISPPARAMS dp = {}; dp.cArgs = 0;
    if (FAILED(d->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, DISPATCH_PROPERTYGET, &dp, out, nullptr, nullptr)))
        return false;
    return true;
}
static bool DispSet(IDispatch* d, const wchar_t* name, VARIANT* val) {
    if (!d) return false;
    DISPID id; OLECHAR* n = const_cast<OLECHAR*>(name);
    if (FAILED(d->GetIDsOfNames(IID_NULL, &n, 1, LOCALE_USER_DEFAULT, &id))) return false;
    VARIANTARG arg; VariantInit(&arg);
    VariantCopy(&arg, val);           // 值直接作为参数（保留类型），不需 VT_VARIANT 嵌套
    DISPID putid = DISPID_PROPERTYPUT;
    DISPPARAMS dp = {&arg, &putid, 1, 1};
    VARIANT res; VariantInit(&res);
    bool ok = SUCCEEDED(d->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, DISPATCH_PROPERTYPUT, &dp, &res, nullptr, nullptr));
    VariantClear(&arg); VariantClear(&res);
    return ok;
}
static bool DispCall(IDispatch* d, const wchar_t* name, VARIANT* args, UINT nargs) {
    if (!d) return false;
    DISPID id; OLECHAR* n = const_cast<OLECHAR*>(name);
    if (FAILED(d->GetIDsOfNames(IID_NULL, &n, 1, LOCALE_USER_DEFAULT, &id))) return false;
    // 反向排列（IDispatch 参数逆序）
    VARIANTARG* rev = nargs ? new VARIANTARG[nargs] : nullptr;
    for (UINT i = 0; i < nargs; i++) { VariantInit(&rev[i]); VariantCopy(&rev[i], &args[nargs-1-i]); }
    DISPPARAMS dp = {rev, nullptr, nargs, 0};
    VARIANT res; VariantInit(&res);
    bool ok = SUCCEEDED(d->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, DISPATCH_METHOD, &dp, &res, nullptr, nullptr));
    for (UINT i = 0; i < nargs; i++) VariantClear(&rev[i]);
    delete[] rev; VariantClear(&res);
    return ok;
}
static VARIANT VInt(int i){ VARIANT v; VariantInit(&v); V_VT(&v)=VT_I4; V_I4(&v)=i; return v; }
static VARIANT VBool(bool b){ VARIANT v; VariantInit(&v); V_VT(&v)=VT_BOOL; V_BOOL(&v)=b?-1:0; return v; }
static VARIANT VStr(const wchar_t* s){ VARIANT v; VariantInit(&v); V_VT(&v)=VT_BSTR; V_BSTR(&v)=SysAllocString(s); return v; }

// ============================================================================
// IMsRdpExtendedSettings（官方 GUID，只定义 set_Property）
// ============================================================================
MIDL_INTERFACE("302D8188-0052-4807-806A-362B628F9AC5")
IMsRdpExtendedSettings_ : public IUnknown {
    virtual HRESULT __stdcall set_Property(BSTR propertyName, VARIANT* value) = 0;
    virtual HRESULT __stdcall get_Property(BSTR propertyName, VARIANT* value) = 0;
};

// ============================================================================
// RDP 事件 sink（实现 IMsTscAxEvents，IDispatch 方式）
// ============================================================================
class RdpEventSink : public IDispatch {
    volatile LONG _refs = 1;
    std::function<void(int)> _onLogin;      // 1
    std::function<void(int)> _onDisconn;    // 4
    std::function<void(int)> _onFatal;      // 10
    std::function<void(int)> _onLogonErr;   // 22
public:
    RdpEventSink(std::function<void(int)> l, std::function<void(int)> d,
                 std::function<void(int)> f, std::function<void(int)> e)
        : _onLogin(std::move(l)), _onDisconn(std::move(d)), _onFatal(std::move(f)), _onLogonErr(std::move(e)) {}
    STDMETHODIMP QueryInterface(REFIID riid, void** pp) override {
        if (!pp) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IDispatch || riid == IID_IMsTscAxEvents) {
            *pp = this; AddRef(); return S_OK;
        }
        *pp = nullptr; return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return (ULONG)InterlockedIncrement(&_refs); }
    STDMETHODIMP_(ULONG) Release() override { LONG r = InterlockedDecrement(&_refs); if (r==0) delete this; return (ULONG)r; }
    STDMETHODIMP GetTypeInfoCount(UINT* p) override { if(p)*p=0; return S_OK; }
    STDMETHODIMP GetTypeInfo(UINT, LCID, ITypeInfo**) override { return E_NOTIMPL; }
    STDMETHODIMP GetIDsOfNames(REFIID, LPOLESTR*, UINT, LCID, DISPID*) override { return E_NOTIMPL; }
    STDMETHODIMP Invoke(DISPID d, REFIID, LCID, WORD wFlags, DISPPARAMS* dp, VARIANT*, EXCEPINFO*, UINT*) override {
        if (!dp) return E_INVALIDARG;
        int arg = 0;
        if (dp->cArgs > 0 && V_VT(&dp->rgvarg[dp->cArgs-1]) == VT_I4) arg = V_I4(&dp->rgvarg[dp->cArgs-1]);
        switch (d) {
            case 3: _onLogin(arg); break;   // OnLoginComplete
            case 4: _onDisconn(arg); break; // OnDisconnected
            case 10: _onFatal(arg); break;  // OnFatalError
            case 22: _onLogonErr(arg); break;// OnLogonError
        }
        return S_OK;
    }
};

// ============================================================================
// 运行配置
// ============================================================================
struct HostConfig {
    std::wstring server = L"localhost";
    int port = 3389;
    int desktopW = Cfg::DesktopW, desktopH = Cfg::DesktopH;
    std::wstring theme, accent = L"red";   // theme 空=未指定 → 随系统主题（AppsUseLightTheme）
    std::wstring themeFile, statusFile, cmdFile, inputPortFile;
    std::wstring logoFile;
    bool startSmall = false;          // 启动形态：小窗
    bool nofocus = false;
    int posX = 0, posY = 0;      // 兜底落点
    HWND ownerHwnd = nullptr;
    DWORD parentPid = 0;
    bool pageVisible = true;
    bool anchorValid = false;
    int anchorX=0, anchorY=0, anchorW=0, anchorH=0, anchorRight=-1;
};

// ============================================================================
// 状态机（追加写 _status.txt，最后一行有效）
// ============================================================================
class StatusWriter {
    std::wstring _f;
    void write(const std::wstring& line) {
        if (_f.empty()) return;
        std::wofstream of(_f, std::ios::app);
        if (of) { of << line << L"\n"; }
    }
public:
    explicit StatusWriter(std::wstring f) : _f(std::move(f)) {
        // 清空旧状态
        std::wofstream of(_f, std::ios::trunc); of.close();
    }
    void connecting() { write(L"STATE connecting"); }
    void hwnd(HWND h) { wchar_t b[64]; swprintf(b,64,L"HWND %lld", (long long)(intptr_t)h); write(b); }
    void closed() { write(L"STATE closed"); }
    void failed(const std::wstring& msg) { write(L"STATE failed|" + msg); }
    void note(const std::wstring& s) { write(s); }
};

// ============================================================================
// 全局状态
// ============================================================================
static HostConfig  g_cfg;
static StatusWriter* g_status = nullptr;
static HWND  g_hwnd = nullptr;
static HWND  g_rdpHwnd = nullptr;      // RDP ActiveX 就地激活子窗口
static bool  g_large = false;          // 是否大窗
static bool  g_rdpConnected = false;   // RDP 是否连上
static bool  g_rdpPainted = false;     // 已画画面（未连上前画黑底）
static bool  g_closing = false;
static bool  g_dragging = false;
static POINT g_dragStartMouse, g_dragStartWnd;
static bool  g_hovering = false;
static bool  g_taskRunning = false;
static bool  g_pageVisible = true;
static bool  g_sizing = false;         // 大窗是否正被用户拖拽缩放（ENTERSIZEMOVE..EXITSIZEMOVE）
static int   g_smallW = Cfg::SmallW, g_smallH = Cfg::SmallH;
static HBRUSH g_bgBrush = nullptr;     // 未连接黑底
static HINSTANCE g_hInst = nullptr;

// ---- 视觉：毛玻璃悬停提示（中央胶囊 + 右上角 ✕）----
static ULONG_PTR g_gdiplusToken = 0;
#define TID_REVEAL 11   // 16ms 淡入淡出
#define TID_HOVER  12   // 60ms 悬停检测
#define TID_RDPSCALE 13 // 32ms 等比缩放贴合（对齐 C# _resizeWatch：让 RDP 渲染窗口贴合客户区）
struct GlassShot { std::vector<uint32_t> px; int w=0, h=0; bool ok=false; };
struct GlassCtrl {
    HWND   hwnd  = nullptr;
    bool   isHint = false;   // true=中央胶囊, false=✕ 按钮
    bool   show  = false;    // 显示目标（悬停）
    float  reveal = 0;       // 当前淡入淡出值 0..1
    bool   hot   = false;
    bool   down  = false;
    GlassShot glass;
};
static GlassCtrl g_hint, g_close;
static RECT g_hintRc, g_closeRc;   // 小窗内控件矩形（父窗口客户区坐标）

// ============================================================================
// 工具
// ============================================================================
static std::wstring widen(const char* s) {
    if (!s) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], n);
    w.resize(n-1);
    return w;
}
static double dpiScaleFor(HWND h) {
    UINT dpi = GetDpiForWindow(h);
    return dpi / 96.0;
}
// 逻辑像素 → 当前窗口 DPI 下的物理像素（PerMonitorV2：150% 缩放下 40 → 60）。
// 自绘标题栏的高度/图标/文字/按钮必须走这里，否则高 DPI 下会被压成一条"夹生"的窄条。
static double uiScale() {
    if (!g_hwnd) return 1.0;
    UINT dpi = GetDpiForWindow(g_hwnd);
    if (!dpi) dpi = 96;
    return dpi / 96.0;
}
static int uiPx(double logical) { return (int)std::lround(logical * uiScale()); }

// ============================================================================
// RDP ActiveX 就地激活容器（IOleClientSite / IOleInPlaceSite 最小实现）
// ============================================================================
class OleInPlaceSite : public IOleInPlaceSite, public IOleClientSite, public IOleControlSite {
    volatile LONG _refs = 1;
    HWND _host;
    std::function<void(void)> _onActivated;
public:
    OleInPlaceSite(HWND h, std::function<void(void)> onAct) : _host(h), _onActivated(std::move(onAct)) {}
    STDMETHODIMP QueryInterface(REFIID riid, void** pp) override {
        if (!pp) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IOleClientSite) *pp = static_cast<IOleClientSite*>(this);
        else if (riid == IID_IOleInPlaceSite) *pp = static_cast<IOleInPlaceSite*>(this);
        else if (riid == IID_IOleControlSite) *pp = static_cast<IOleControlSite*>(this);
        else { *pp=nullptr; return E_NOINTERFACE; }
        AddRef(); return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return (ULONG)InterlockedIncrement(&_refs); }
    STDMETHODIMP_(ULONG) Release() override { LONG r=InterlockedDecrement(&_refs); if(r==0) delete this; return (ULONG)r; }

    // IOleClientSite
    STDMETHODIMP SaveObject() override { return E_NOTIMPL; }
    STDMETHODIMP GetMoniker(DWORD, DWORD, IMoniker**) override { return E_NOTIMPL; }
    STDMETHODIMP GetContainer(IOleContainer** c) override { if(c)*c=nullptr; return E_NOINTERFACE; }
    STDMETHODIMP ShowObject() override { return S_OK; }
    STDMETHODIMP OnShowWindow(BOOL) override { return S_OK; }
    STDMETHODIMP RequestNewObjectLayout() override { return S_OK; }

    // IOleInPlaceSite
    STDMETHODIMP GetWindow(HWND* p) override { if(p)*p=_host; return p?S_OK:E_FAIL; }
    STDMETHODIMP ContextSensitiveHelp(BOOL) override { return E_NOTIMPL; }
    STDMETHODIMP CanInPlaceActivate() override { return S_OK; }
    STDMETHODIMP OnInPlaceActivate() override { if(_onActivated)_onActivated(); return S_OK; }
    STDMETHODIMP OnUIActivate() override { return S_OK; }
    STDMETHODIMP GetWindowContext(IOleInPlaceFrame** frame, IOleInPlaceUIWindow** doc, LPRECT rc, LPRECT rcClip, LPOLEINPLACEFRAMEINFO fi) override {
        if (frame) *frame = nullptr; if (doc) *doc = nullptr;
        // RDP ActiveX 激活时按这个初始 rect 布局外层窗口。必须用真实客户区（而非写死 1024x576），
        // 否则 RDP 外层窗口尺寸被锁定在 1024x576，SetObjectRects 也缩不动 → 预览只能看到桌面一角。
        // 【系统原生标题栏】大窗的标题栏在【非客户区】，客户区从标题栏下方开始，
        // 所以这里 rect 就是整个客户区，不需要再减去任何自绘标题栏高度。
        RECT cr{0,0,Cfg::SmallW,Cfg::SmallH};
        if (_host) GetClientRect(_host, &cr);
        if (rc) *rc = cr;
        if (rcClip) *rcClip = cr;
        if (fi) { fi->cb=sizeof(*fi); fi->fMDIApp=FALSE; fi->hwndFrame=_host; fi->haccel=nullptr; fi->cAccelEntries=0; }
        return S_OK;
    }
    STDMETHODIMP Scroll(SIZE) override { return S_OK; }
    STDMETHODIMP OnUIDeactivate(BOOL) override { return S_OK; }
    STDMETHODIMP OnInPlaceDeactivate() override { return S_OK; }
    STDMETHODIMP DiscardUndoState() override { return S_OK; }
    STDMETHODIMP DeactivateAndUndo() override { return E_NOTIMPL; }
    // OLE 在自身重布局时会回问宿主"目标位置/尺寸"。系统原生标题栏下客户区 == 画面区，
    // 因此期望矩形就是整个客户区；尺寸明显不符时交给 layoutChrome 的定时器纠正。
    STDMETHODIMP OnPosRectChange(LPCRECT lprc) override {
        if (lprc && _host) {
            RECT cr; GetClientRect(_host, &cr);
            long dw = labs((long)lprc->right  - (long)(lprc->left));
            long dh = labs((long)lprc->bottom - (long)(lprc->top));
            long ww = cr.right - cr.left;
            long wh = cr.bottom - cr.top;
            if (dw != ww || dh != wh) {
                return S_OK;   // 尺寸不对 → 让定时器纠正，这里不重复动作（避免死循环）
            }
        }
        return S_OK;
    }

    // IOleControlSite
    STDMETHODIMP OnControlInfoChanged() override { return S_OK; }
    STDMETHODIMP LockInPlaceActive(BOOL) override { return S_OK; }
    STDMETHODIMP GetExtendedControl(IDispatch** d) override { if(d)*d=nullptr; return E_NOTIMPL; }
    STDMETHODIMP TransformCoords(POINTL*, POINTF*, DWORD) override { return S_OK; }
    STDMETHODIMP TranslateAccelerator(LPMSG, DWORD) override { return S_FALSE; }
    STDMETHODIMP OnFocus(BOOL) override { return S_OK; }
    STDMETHODIMP ShowPropertyFrame() override { return E_NOTIMPL; }
};

// ============================================================================
// RDP 客户端封装（IDispatch 后期绑定 + OLE 就地激活 + 事件）
// ============================================================================
class RdpClient {
    IDispatch* _ax = nullptr;
    IOleObject* _ole = nullptr;
    OleInPlaceSite* _site = nullptr;
    DWORD _adviseCookie = 0;
    std::thread _eventThread;
public:
    std::function<void(void)> onLogin;       // OnLoginComplete
    std::function<void(int)>  onDisconnect;
    std::function<void(int)>  onFatal;
    std::function<void(int)>  onLogonError;

    bool CreateInWindow(HWND host) {
        HRESULT hr;
        IUnknown* unk = nullptr;
        if (FAILED(CoCreateInstance(CLSID_MsRdpClient, nullptr, CLSCTX_INPROC_SERVER, IID_IUnknown, (void**)&unk)))
            return false;
        if (FAILED(unk->QueryInterface(IID_IDispatch, (void**)&_ax))) { unk->Release(); return false; }
        if (FAILED(unk->QueryInterface(IID_IOleObject, (void**)&_ole))) { unk->Release(); return false; }

        _site = new OleInPlaceSite(host, [this]{
            // 就地激活后拿子窗口
            IOleInPlaceObject* ipo = nullptr;
            if (_ole && SUCCEEDED(_ole->QueryInterface(IID_IOleInPlaceObject, (void**)&ipo)) && ipo) {
                HWND w = nullptr; ipo->GetWindow(&w); g_rdpHwnd = w; ipo->Release();
                log("rdp inplace window=0x%p", (void*)g_rdpHwnd);
            } else { log("rdp inplace GetWindow FAILED"); }
        });
        _ole->SetClientSite(_site);
        OleSetContainedObject(_ax, TRUE);

        // 事件 sink：IMsTscAxEvents 连接点
        {
            IConnectionPointContainer* cpc = nullptr;
            if (SUCCEEDED(_ax->QueryInterface(IID_IConnectionPointContainer, (void**)&cpc))) {
                IConnectionPoint* cp = nullptr;
                if (SUCCEEDED(cpc->FindConnectionPoint(IID_IMsTscAxEvents, &cp))) {
                    RdpEventSink* sink = new RdpEventSink(
                        [this](int){ if(onLogin) onLogin(); },
                        [this](int r){ if(onDisconnect) onDisconnect(r); },
                        [this](int c){ if(onFatal) onFatal(c); },
                        [this](int c){ if(onLogonError) onLogonError(c); });
                    cp->Advise(static_cast<IUnknown*>(sink), &_adviseCookie);
                    sink->Release();
                    cp->Release();
                }
                cpc->Release();
            }
        }

        _ole->DoVerb(OLEIVERB_INPLACEACTIVATE, nullptr, _site, 0, host, nullptr);
        unk->Release();
        return true;
    }

    void Resize(RECT rc) {
        if (!_ole) return;
        IOleInPlaceObject* ipo = nullptr;
        if (SUCCEEDED(_ole->QueryInterface(IID_IOleInPlaceObject, (void**)&ipo)) && ipo) {
            ipo->SetObjectRects(&rc, &rc);
            ipo->Release();
        }
    }

    // 重新获取 RDP 就地激活子窗口（连接前后内部窗口句柄会变，激活回调里 GetWindow 常为空，
    // 对齐 C# _axWatch：周期性发现并重挂）
    void Reacquire() {
        if (!_ole) return;
        IOleInPlaceObject* ipo = nullptr;
        if (SUCCEEDED(_ole->QueryInterface(IID_IOleInPlaceObject, (void**)&ipo)) && ipo) {
            HWND w = nullptr;
            if (SUCCEEDED(ipo->GetWindow(&w)) && w) g_rdpHwnd = w;
            ipo->Release();
        }
    }

    bool Connect(const HostConfig& c) {
        if (!_ax) return false;
        // Server / DesktopWidth / DesktopHeight / ColorDepth / 文案
        VARIANT vServer = VStr(L"localhost");
        DispSet(_ax, L"Server", &vServer); VariantClear(&vServer);
        int w = std::max(200, std::min(c.desktopW, 8192));
        int h = std::max(200, std::min(c.desktopH, 8192));
        VARIANT vw = VInt(w), vh = VInt(h), vdepth = VInt(32);
        DispSet(_ax, L"DesktopWidth", &vw); DispSet(_ax, L"DesktopHeight", &vh);
        DispSet(_ax, L"ColorDepth", &vdepth);
        VARIANT vct = VStr(L"正在创建浮灵饰界桌面分身..."), vdt = VStr(L"浮灵饰界桌面分身已断开");
        DispSet(_ax, L"ConnectingText", &vct); DispSet(_ax, L"DisconnectedText", &vdt);
        VariantClear(&vw); VariantClear(&vh); VariantClear(&vdepth); VariantClear(&vct); VariantClear(&vdt);

        // SecuredSettings2
        VARIANT vSec; VariantInit(&vSec);
        if (DispGet(_ax, L"SecuredSettings2", &vSec) && V_VT(&vSec)==VT_DISPATCH) {
            IDispatch* sec = V_DISPATCH(&vSec);
            VARIANT kh = VInt(0); DispSet(sec, L"KeyboardHookMode", &kh);
            VARIANT ar = VInt(0); DispSet(sec, L"AudioRedirectionMode", &ar); // 0=带到客户端
            VariantClear(&kh); VariantClear(&ar);
        }
        VariantClear(&vSec);

        // AdvancedSettings7
        VARIANT vAdv; VariantInit(&vAdv);
        if (DispGet(_ax, L"AdvancedSettings7", &vAdv) && V_VT(&vAdv)==VT_DISPATCH) {
            IDispatch* adv = V_DISPATCH(&vAdv);
            VARIANT vport = VInt(c.port); DispSet(adv, L"RDPPort", &vport); VariantClear(&vport);
            VARIANT vcs = VBool(true); DispSet(adv, L"EnableCredSspSupport", &vcs); VariantClear(&vcs);
            VARIANT vwk = VInt(1); DispSet(adv, L"EnableWindowsKey", &vwk); VariantClear(&vwk);
            VARIANT vss = VBool(true); bool okSS = DispSet(adv, L"SmartSizing", &vss); VariantClear(&vss);
            if (!okSS) log("SmartSizing set FAILED");
            else log("SmartSizing set ok");
        }
        VariantClear(&vAdv);

        // IMsRdpExtendedSettings：EnableZoom + ConnectToChildSession
        IMsRdpExtendedSettings_* ext = nullptr;
        if (SUCCEEDED(_ax->QueryInterface(IID_IMsRdpExtendedSettings, (void**)&ext))) {
            // EnableZoom 可能与 SmartSizing 冲突导致不缩放 → 显式关闭，让 SmartSizing 真正等比缩放
            VARIANT vz = VBool(false); ext->set_Property(SysAllocString(L"EnableZoom"), &vz); VariantClear(&vz);
            VARIANT vc = VBool(true); ext->set_Property(SysAllocString(L"ConnectToChildSession"), &vc); VariantClear(&vc);
            ext->Release();
        }

        VARIANT noarg;
        VariantInit(&noarg);
        DispCall(_ax, L"Connect", nullptr, 0);
        VariantClear(&noarg);
        return true;
    }

    void Disconnect() {
        if (!_ax) return;
        DispCall(_ax, L"Disconnect", nullptr, 0);
    }

    void SendMouse(int flags, int x, int y) {
        if (!_ax) return;
        VARIANT a[3] = { VInt(flags), VInt(x), VInt(y) };
        DispCall(_ax, L"SendMouseEvent", a, 3);
        for (auto& v : a) VariantClear(&v);
    }
    void SendKey(int scan, int up) {
        if (!_ax) return;
        VARIANT a[2] = { VInt(scan), VInt(up) };
        DispCall(_ax, L"SendKeyboardEvent", a, 2);
        for (auto& v : a) VariantClear(&v);
    }

    ~RdpClient() {
        if (_adviseCookie) {
            // 断开事件连接点
            IConnectionPointContainer* cpc = nullptr;
            if (_ax && SUCCEEDED(_ax->QueryInterface(IID_IConnectionPointContainer, (void**)&cpc))) {
                IConnectionPoint* cp = nullptr;
                if (SUCCEEDED(cpc->FindConnectionPoint(IID_IMsTscAxEvents, &cp))) {
                    cp->Unadvise(_adviseCookie); cp->Release();
                }
                cpc->Release();
            }
        }
        if (_ole) { _ole->Close(OLECLOSE_NOSAVE); _ole->Release(); }
        if (_ax) _ax->Release();
        if (_site) _site->Release();
    }
};

static RdpClient g_rdp;

// ============================================================================
// 状态/主题/停止文件轮询 + 父进程看门狗 + owner 绑定
// ============================================================================
static std::atomic<bool> g_running{true};

static void pollThread() {
    auto lastStop = std::chrono::steady_clock::now();
    auto lastTheme = lastStop;
    while (g_running) {
        Sleep(250);
        auto now = std::chrono::steady_clock::now();
        // stop 文件
        if (!g_cfg.cmdFile.empty() && std::chrono::duration_cast<std::chrono::milliseconds>(now-lastStop).count() >= 500) {
            lastStop = now;
            std::ifstream f(g_cfg.cmdFile);
            std::string s; if (f) std::getline(f, s);
            if (!s.empty() && s.find("stop") != std::string::npos) {
                log("stop file -> closing");
                PostMessage(g_hwnd, WM_CLOSE, 0, 0);
            }
        }
        // theme 文件（暂只记录，标题栏按初始主题绘制）
        // 父进程看门狗
        if (g_cfg.parentPid) {
            HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, g_cfg.parentPid);
            if (!h) { log("parent gone -> closing"); PostMessage(g_hwnd, WM_CLOSE, 0, 0); }
            else CloseHandle(h);
        }
    }
}

// ============================================================================
// TCP 输入注入服务（本地端口，JSON 行协议与 desktopSession.js sendInput 对齐）
// ============================================================================
static void dispatchInputLine(const std::string& line) {
    // 极简 JSON 解析：只取需要的键
    auto kv = [&](const std::string& key) -> std::string {
        std::string p = "\"" + key + "\":";
        size_t i = line.find(p); if (i==std::string::npos) return "";
        i += p.size(); while (i<line.size() && (isspace(line[i])||line[i]=='"')) i++;
        size_t j = i;
        while (j<line.size() && line[j]!='"' && line[j]!=',' && line[j]!='}' && !isspace(line[j])) j++;
        std::string v = line.substr(i, j-i);
        if (v.size()>=2 && v.front()=='"' && v.back()=='"') v = v.substr(1, v.size()-2);
        return v;
    };
    std::string act = kv("action");
    if (act.empty()) return;
    int x = 0, y = 0;
    auto inum = [&](const std::string& k) -> int { std::string v = kv(k); return v.empty()?0:atoi(v.c_str()); };
    if (act=="move" || act=="click" || act=="dblclick" || act=="down" || act=="up") {
        x = inum("x"); y = inum("y");
        std::string btn = kv("button");
        bool right = btn=="right";
        if (act=="move") g_rdp.SendMouse(0x0001, x, y);
        else if (act=="click") { g_rdp.SendMouse(right?0x0008:0x0002, x, y); g_rdp.SendMouse(right?0x0010:0x0004, x, y); }
        else if (act=="dblclick") { for(int k=0;k<2;k++){ g_rdp.SendMouse(right?0x0008:0x0002,x,y); g_rdp.SendMouse(right?0x0010:0x0004,x,y);} }
        else if (act=="down") g_rdp.SendMouse(right?0x0008:0x0002, x, y);
        else if (act=="up") g_rdp.SendMouse(right?0x0010:0x0004, x, y);
    } else if (act=="scroll") {
        int delta = inum("delta");
        g_rdp.SendMouse(0x0800, inum("x"), inum("y"));
        (void)delta;
    } else if (act=="key") {
        int code = inum("code"); bool up = kv("up")=="true"||kv("up")=="1";
        g_rdp.SendKey(code, up?1:0);
    } else if (act=="hotkey") {
        // 组合键：逐键按下再释放
        // 简化：解析 keys 数组
        std::string ks = kv("keys");
        (void)ks;
    }
}
static void tcpThread() {
    WSADATA wsa; WSAStartup(MAKEWORD(2,2), &wsa);
    SOCKET srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv == INVALID_SOCKET) { WSACleanup(); return; }
    BOOL reuse = TRUE; setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));
    sockaddr_in sa{}; sa.sin_family = AF_INET; sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK); sa.sin_port = 0;
    if (bind(srv, (sockaddr*)&sa, sizeof(sa)) != 0) { closesocket(srv); WSACleanup(); return; }
    int slen = sizeof(sa); getsockname(srv, (sockaddr*)&sa, &slen);
    int port = ntohs(sa.sin_port);
    // 写端口文件
    if (!g_cfg.inputPortFile.empty()) {
        std::wofstream of(g_cfg.inputPortFile, std::ios::trunc);
        if (of) of << port << L"\n";
    }
    listen(srv, 4);
    log("input server on port %d", port);
    while (g_running) {
        SOCKET c = accept(srv, nullptr, nullptr);
        if (c == INVALID_SOCKET) continue;
        char buf[4096]; int n = recv(c, buf, sizeof(buf)-1, 0);
        if (n > 0) { buf[n]=0; std::stringstream ss(buf); std::string line;
            while (std::getline(ss, line)) if (!line.empty()) dispatchInputLine(line); }
        closesocket(c);
    }
    closesocket(srv); WSACleanup();
}

// ============================================================================
// 窗口过程
// ============================================================================
static int HitTest(int sx, int sy) {
    RECT rc; GetWindowRect(g_hwnd, &rc);
    int x = sx - rc.left, y = sy - rc.top;
    int w = rc.right-rc.left, h = rc.bottom-rc.top;
    int edge = 6;
    if (x < edge && y < edge) return HTTOPLEFT;
    if (x >= w-edge && y < edge) return HTTOPRIGHT;
    if (x < edge && y >= h-edge) return HTBOTTOMLEFT;
    if (x >= w-edge && y >= h-edge) return HTBOTTOMRIGHT;
    if (y < edge) return HTTOP;
    if (y >= h-edge) return HTBOTTOM;
    if (x < edge) return HTLEFT;
    if (x >= w-edge) return HTRIGHT;
    return HTCLIENT;
}

// 标题栏毛玻璃：采用与主程序（AI Lobster）完全一致的系统级 DWM Acrylic 方案 ——
//   主程序用 Electron `backgroundMaterial:'acrylic'`，底层就是 DWMWA_SYSTEMBACKDROP_TYPE
//   = DWMSBT_TRANSIENTWINDOW(3)，在当前 Win11 build 上真正模糊「桌面壁纸本体」；
//   而 SetWindowCompositionAttribute 的 ACCENT_ENABLE_BLURBEHIND/ACRYLICBLURBEHIND
//   在此 build 完全不渲染（见 src/main/main.js 的实测注释）。
//
// 两种形态要区别对待（这是之前"顶部一条无用空白/标题栏被吃掉"的根因）：
//   · 大窗（有 WS_CAPTION）：**绝对不能**调 DwmExtendFrameIntoClientArea。
//     它会把 DWM 框强行扩展进客户区，吞掉系统标题栏的高度，客户区顶部多出一条
//     什么都不画的 frame 带（用户看到的"顶部无用横条"），标题文字/图标也会被裁。
//     只设 DWMWA_SYSTEMBACKDROP_TYPE，系统就会把【原生标题栏】画成亚克力毛玻璃，
//     标题文字、logo、最小化/最大化/关闭按钮全部由系统绘制与命中。
//   · 小窗（无 WS_CAPTION，WS_POPUP）：没有非客户区，需要把 DWM 框扩展到整个客户区，
//     才能让亚克力背景铺满小窗（内部还有毛玻璃覆盖层）。
// Win10 没有 DWMWA_SYSTEMBACKDROP_TYPE 时回退到经典 blurbehind。
#ifndef DWMWA_SYSTEMBACKDROP_TYPE
#define DWMWA_SYSTEMBACKDROP_TYPE 38
#endif
static void SetAcrylic(HWND h) {
    BOOL dark = g_cfg.theme != L"light";
    int darkMode = dark ? 1 : 0;
    DwmSetWindowAttribute(h, 20, &darkMode, sizeof(darkMode));   // DWMWA_USE_IMMERSIVE_DARK_MODE（毛玻璃色调随深浅主题）

    // 亚克力背景类型：必须先设 backdrop，再决定要不要扩框
    int backdrop = 3;   // DWMSBT_TRANSIENTWINDOW => acrylic（毛玻璃），与主程序一致
    HRESULT hr = DwmSetWindowAttribute(h, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop, sizeof(backdrop));

    LONG st = GetWindowLongPtrW(h, GWL_STYLE);
    bool hasCaption = (st & WS_CAPTION) != 0;
    if (!hasCaption) {
        // 无标题栏形态：把 DWM 框扩到整个客户区，亚克力才能铺满小窗
        MARGINS m{ -1, -1, -1, -1 };
        DwmExtendFrameIntoClientArea(h, &m);
    } else {
        // 有系统标题栏：把之前的扩框撤销（切回小窗时可能已扩过），否则标题栏被吞
        MARGINS m{ 0, 0, 0, 0 };
        DwmExtendFrameIntoClientArea(h, &m);
    }

    if (FAILED(hr)) {
        // Win10 回退：经典 blurbehind（ACCENT_ENABLE_BLURBEHIND=3）。Win11 上此路不渲染，仅兜底。
        HMODULE u = GetModuleHandleW(L"user32.dll");
        if (!u) return;
        struct ACCENT { int accent; int flags; int color; int anim; };
        struct WCA { int cmd; void* data; int size; };
        typedef BOOL (WINAPI* F)(HWND, WCA*);
        F f = (F)GetProcAddress(u, "SetWindowCompositionAttribute");
        if (!f) return;
        int tint = dark ? (int)0xB2101218 : (int)0xB2F0F2F6; // 0xAABBGGRR 半透明主题色
        ACCENT a{ 3 /*ACCENT_ENABLE_BLURBEHIND*/, 0, tint, 0 };
        WCA w{ 19, &a, sizeof(a) };
        f(h, &w);
    }
}

static BOOL CALLBACK RdpChildScale(HWND h, LPARAM l);   // 前向声明（定义见下，用于铺满内层渲染面）

// 画面区布局：大窗用【系统原生标题栏】（位于非客户区），客户区整块都是 RDP 画面；
// 小窗无边框，同样整块客户区。所以两种形态下 bar 恒为 0。
static void layoutChrome() {
    RECT rc; GetClientRect(g_hwnd, &rc);
    if (g_rdpHwnd) {
        RECT rdp = { 0, 0, rc.right, rc.bottom };
        SetWindowPos(g_rdpHwnd, nullptr, rdp.left, rdp.top,
                     rdp.right-rdp.left, rdp.bottom-rdp.top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        g_rdp.Resize(rdp);
        // 内层渲染面（IHWindowClass 等）一并钉到客户区：放大时画面即时铺满整个窗口，
        // 而不是只靠 32ms 定时器——否则放大瞬间/拖拽过程中仍会露出会话分辨率灰底/空白。
        RECT inner = { 0, 0, rc.right, rc.bottom };
        EnumChildWindows(g_rdpHwnd, RdpChildScale, (LPARAM)&inner);
    }
}
static bool InRect(const RECT& r, int x, int y) { return x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom; }

static void SetLarge(bool large);   // 前向声明

static HICON g_titleIconSm = nullptr; // 系统标题栏小图标（ApplyTheme 切换，优先来自用户 PNG）
static HICON g_titleIconBg = nullptr; // 系统标题栏大图标 / Alt-Tab 图标（ApplyTheme 切换）


// ============================================================================
// 真·毛玻璃：PrintWindow 抓 RDP 画面 → 缩放模糊 → 子窗口自绘（中央胶囊 / 右上角 ✕）
// 复刻 C# HostForm.cs 的 Glass/GetGlassBackdrop/ChromeButton/HintCapsule/ChromeReveal。
// ============================================================================
// 抓帧必须走 CreateDIBSection（GDI+ DDB 在 DWM 下 PrintWindow 会全黑）→ 复刻 Glass.Capture
static bool PrintWindowCapture(HWND hwnd, int w, int h, std::vector<uint32_t>& out) {
    if (!hwnd || w <= 0 || h <= 0) return false;
    HDC wdc = GetWindowDC(hwnd);
    if (!wdc) return false;
    HDC mdc = CreateCompatibleDC(wdc);
    if (!mdc) { ReleaseDC(hwnd, wdc); return false; }
    BITMAPINFO bmi{};                          // 32bpp、负高度 = top-down
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP hbm = CreateDIBSection(mdc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (!hbm || !bits) { DeleteObject(hbm); DeleteDC(mdc); ReleaseDC(hwnd, wdc); return false; }
    HBITMAP old = (HBITMAP)SelectObject(mdc, hbm);
    BOOL ok = PrintWindow(hwnd, mdc, 2 /*PW_RENDERFULLCONTENT，D3D 子表面也能抓到*/);
    if (ok) {
        out.resize((size_t)w * h);
        const uint32_t* src = (const uint32_t*)bits;
        for (size_t i = 0; i < (size_t)w * h; i++) {   // DIB=BGRA → GDI+ ARGB(0xAARRGGBB)，alpha 恒为 0 需补 255
            uint32_t b = src[i];
            uint8_t r = (uint8_t)b, g = (uint8_t)(b >> 8), bl = (uint8_t)(b >> 16);
            out[i] = 0xFF000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | bl;
        }
    }
    SelectObject(mdc, old);
    DeleteObject(hbm);
    DeleteDC(mdc);
    ReleaseDC(hwnd, wdc);
    return ok;
}
static int AvgBrightness(const std::vector<uint32_t>& px, int w, int h) {
    if (px.empty() || w <= 0 || h <= 0) return -1;
    long sum = 0; int n = 0;
    int sy = std::max(1, h / 8), sx = std::max(1, w / 8);
    for (int y = 0; y < h; y += sy) for (int x = 0; x < w; x += sx) {
        uint32_t c = px[(size_t)y * w + x];
        sum += (((c >> 16) & 0xFF) + ((c >> 8) & 0xFF) + (c & 0xFF)) / 3; n++;
    }
    return n ? (int)(sum / n) : -1;
}
static bool IsNearlyBlack(const std::vector<uint32_t>& px, int w, int h) { return AvgBrightness(px, w, h) < 10; }

// 复刻 Glass.BlurCrop：区域缩到 1/downscale 再放大回来（盒式模糊等效）
static void BlurCrop(const std::vector<uint32_t>& src, int srcW, int srcH,
                     int cx0, int cy0, int cw, int ch, int ds, std::vector<uint32_t>& out) {
    int sw = std::max(1, cw / ds), sh = std::max(1, ch / ds);
    std::vector<uint32_t> smallBmp((size_t)sw * sh);
    for (int j = 0; j < sh; j++) {
        int by0 = cy0 + j * ds, by1 = std::min(srcH, by0 + ds);
        for (int i = 0; i < sw; i++) {
            int bx0 = cx0 + i * ds, bx1 = std::min(srcW, bx0 + ds);
            long r = 0, g = 0, b = 0; int cnt = 0;
            for (int yy = by0; yy < by1; yy++) for (int xx = bx0; xx < bx1; xx++) {
                uint32_t c = src[(size_t)yy * srcW + xx];
                r += (c >> 16) & 0xFF; g += (c >> 8) & 0xFF; b += c & 0xFF; cnt++;
            }
            if (cnt) { r /= cnt; g /= cnt; b /= cnt; }
            smallBmp[(size_t)j * sw + i] = 0xFF000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
        }
    }
    out.resize((size_t)cw * ch);
    for (int y = 0; y < ch; y++) {
        float fy = (y + 0.5f) * sh / ch - 0.5f;
        int y0 = (int)floorf(fy); if (y0 < 0) y0 = 0; int y1 = y0 + 1; if (y1 >= sh) y1 = sh - 1;
        float wy = fy - y0;
        for (int x = 0; x < cw; x++) {
            float fx = (x + 0.5f) * sw / cw - 0.5f;
            int x0 = (int)floorf(fx); if (x0 < 0) x0 = 0; int x1 = x0 + 1; if (x1 >= sw) x1 = sw - 1;
            float wx = fx - x0;
            uint32_t a = smallBmp[(size_t)y0 * sw + x0], b = smallBmp[(size_t)y0 * sw + x1];
            uint32_t c = smallBmp[(size_t)y1 * sw + x0], d = smallBmp[(size_t)y1 * sw + x1];
            float w00 = (1 - wx) * (1 - wy), w01 = wx * (1 - wy), w10 = (1 - wx) * wy, w11 = wx * wy;
            int r = (int)(((a >> 16) & 0xFF) * w00 + ((b >> 16) & 0xFF) * w01 + ((c >> 16) & 0xFF) * w10 + ((d >> 16) & 0xFF) * w11);
            int g = (int)(((a >> 8) & 0xFF) * w00 + ((b >> 8) & 0xFF) * w01 + ((c >> 8) & 0xFF) * w10 + ((d >> 8) & 0xFF) * w11);
            int bl = (int)((a & 0xFF) * w00 + (b & 0xFF) * w01 + (c & 0xFF) * w10 + (d & 0xFF) * w11);
            out[(size_t)y * cw + x] = 0xFF000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)bl;
        }
    }
}
// 复刻 GetGlassBackdrop：抓 RDP 画面中目标矩形处的玻璃底（带 padding 模糊后裁回）
static GlassShot CaptureGlass(int sx, int sy, int sw, int sh, int downscale) {
    GlassShot g;
    if (!g_rdpHwnd || sw <= 0 || sh <= 0) return g;
    RECT rc; GetClientRect(g_rdpHwnd, &rc);
    int rdpW = rc.right, rdpH = rc.bottom;
    if (rdpW <= 0 || rdpH <= 0) return g;
    int pad = std::max(4, std::min(sw, sh) / 4);
    int cx0 = std::max(0, sx - pad), cy0 = std::max(0, sy - pad);
    int cx1 = std::min(rdpW, sx + sw + pad), cy1 = std::min(rdpH, sy + sh + pad);
    int cw = cx1 - cx0, ch = cy1 - cy0;
    if (cw <= 0 || ch <= 0) return g;
    std::vector<uint32_t> full;
    if (!PrintWindowCapture(g_rdpHwnd, rdpW, rdpH, full)) return g;
    if (IsNearlyBlack(full, rdpW, rdpH)) return g;   // 抓帧失败 → 回退实心
    std::vector<uint32_t> blurred;
    BlurCrop(full, rdpW, rdpH, cx0, cy0, cw, ch, std::max(1, downscale), blurred);
    g.w = sw; g.h = sh; g.px.resize((size_t)sw * sh);
    int bx = sx - cx0, by = sy - cy0;
    for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++)
        g.px[(size_t)y * sw + x] = blurred[(size_t)(y + by) * cw + (x + bx)];
    g.ok = true;
    return g;
}

// 主题色（复刻 HostForm.SetTheme）：dark 默认
static void ThemeColors(bool light, Gdiplus::Color& hintTint, Gdiplus::Color& hintSolid, Gdiplus::Color& hintIcon,
                        Gdiplus::Color& closeTint, Gdiplus::Color& closeSolid, Gdiplus::Color& glyph) {
    if (light) {
        hintTint = Gdiplus::Color(85, 250, 250, 254); hintSolid = Gdiplus::Color(255, 242, 242, 248); hintIcon = Gdiplus::Color(255, 36, 36, 44);
        closeTint = Gdiplus::Color(110, 250, 250, 254); closeSolid = Gdiplus::Color(255, 242, 242, 248); glyph = Gdiplus::Color(255, 36, 36, 44);
    } else {
        hintTint = Gdiplus::Color(62, 10, 12, 18); hintSolid = Gdiplus::Color(255, 26, 27, 34); hintIcon = Gdiplus::Color(255, 246, 246, 252);
        closeTint = Gdiplus::Color(90, 10, 12, 18); closeSolid = Gdiplus::Color(255, 26, 27, 34); glyph = Gdiplus::Color(255, 255, 255);
    }
}

// 复刻 ChromeButton/HintCapsule 的绘制：玻璃底满 alpha 铺 + 叠色随 reveal 走
static void DrawHintIcon(Gdiplus::Graphics& g, const Gdiplus::RectF& r, float rv, bool hot, Gdiplus::Color& ic);   // 前向声明
static void DrawCloseGlyph(Gdiplus::Graphics& g, const Gdiplus::RectF& r, float rv, bool hot, Gdiplus::Color& glyph);
static void DrawGlass(HDC dc, GlassCtrl& c) {
    float rv = c.reveal;
    if (rv <= 0.004f) return;
    RECT r; GetClientRect(c.hwnd, &r);
    int w = r.right - r.left, h = r.bottom - r.top;
    if (w <= 0 || h <= 0) return;
    bool light = (g_cfg.theme == L"light");
    Gdiplus::Color ht, hs, hi, ct, cs, gl;
    ThemeColors(light, ht, hs, hi, ct, cs, gl);

    Gdiplus::Graphics g(dc);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    Gdiplus::RectF rr((float)r.left, (float)r.top, (float)w, (float)h);
    Gdiplus::GraphicsPath path;
    if (c.isHint) {
        float d = (float)std::min(w, h);
        path.AddArc((float)r.left, (float)r.top, d, d, 90, 180);
        path.AddArc((float)(r.right - d), (float)r.top, d, d, 270, 180);
        path.CloseFigure();
    } else {
        path.AddEllipse(rr);
        path.CloseFigure();
    }
    // 底：玻璃底 or 兜底实心
    if (c.glass.ok && c.glass.w == w && c.glass.h == h) {
        g.SetClip(&path);
        Gdiplus::Bitmap bm(c.glass.w, c.glass.h, c.glass.w * 4, PixelFormat32bppARGB, (BYTE*)c.glass.px.data());
        g.DrawImage(&bm, rr);
        Gdiplus::Color& tint = c.isHint ? ht : ct;
        int ta = (int)(tint.GetAlpha() * rv);
        Gdiplus::SolidBrush tb(Gdiplus::Color(ta, tint.GetRed(), tint.GetGreen(), tint.GetBlue()));
        g.FillPath(&tb, &path);
        g.ResetClip();
    } else {
        Gdiplus::Color& solid = c.isHint ? hs : cs;
        Gdiplus::SolidBrush sb(Gdiplus::Color((int)(255 * rv), solid.GetRed(), solid.GetGreen(), solid.GetBlue()));
        g.FillPath(&sb, &path);
    }
    // 图标 / ✕ 字形
    if (c.isHint) DrawHintIcon(g, rr, rv, c.hot, hi);
    else          DrawCloseGlyph(g, rr, rv, c.hot, gl);
}

// 复刻 HintCapsule.DrawIcon：只画窗口图标（外框 + 36% 标题条），带 1px 投影
static void DrawHintIcon(Gdiplus::Graphics& g, const Gdiplus::RectF& r, float rv, bool hot, Gdiplus::Color& ic) {
    float ih = (9.0 > r.Height * 0.42) ? (float)9.0 : r.Height * (float)0.42;
    float iw = ih * 1.18f;
    float ix = r.X + (r.Width - iw) / 2.0f, iy = r.Y + (r.Height - ih) / 2.0f;
    float lw = (1.1 > r.Height / 20.0) ? (float)1.1 : r.Height / 20.0f;
    float off = (1.0 > r.Height / 26.0) ? (float)1.0 : r.Height / 26.0f;
    float scale = hot ? 1.08f : 1.0f;
    float cx = r.X + r.Width / 2.0f, cy = r.Y + r.Height / 2.0f;
    if (scale > 1.001f) { g.TranslateTransform(cx, cy); g.ScaleTransform(scale, scale); g.TranslateTransform(-cx, -cy); }
    Gdiplus::Pen sh(Gdiplus::Color((int)(70 * rv), 0, 0, 0), lw + 0.7f);
    g.DrawRectangle(&sh, ix + off, iy + off, iw, ih);
    g.DrawLine(&sh, ix + off, iy + off + ih * 0.36f, ix + off + iw, iy + off + ih * 0.36f);
    Gdiplus::Pen pen(Gdiplus::Color((int)(255 * rv), ic.GetRed(), ic.GetGreen(), ic.GetBlue()), lw);
    g.DrawRectangle(&pen, ix, iy, iw, ih);
    g.DrawLine(&pen, ix, iy + ih * 0.36f, ix + iw, iy + ih * 0.36f);
    if (scale > 1.001f) g.ResetTransform();
}

// 复刻 ChromeButton.DrawCloseGlyph：两条圆头细线 ✕ + 1px 投影
static void DrawCloseGlyph(Gdiplus::Graphics& g, const Gdiplus::RectF& r, float rv, bool hot, Gdiplus::Color& glyph) {
    float s = r.Width < r.Height ? r.Width : r.Height;
    float arm = s * 0.19f;
    float cx = r.X + r.Width / 2.0f, cy = r.Y + r.Height / 2.0f;
    float w0 = (1.5 > s / 12.0) ? (float)1.5 : s / 12.0f;
    float off = (1.0 > s / 26.0) ? (float)1.0 : s / 26.0f;
    float scale = hot ? 1.08f : 1.0f;
    if (scale > 1.001f) { g.TranslateTransform(cx, cy); g.ScaleTransform(scale, scale); g.TranslateTransform(-cx, -cy); }
    Gdiplus::Color col = hot ? Gdiplus::Color(255, 255, 255) : glyph;
    Gdiplus::Pen sh(Gdiplus::Color((int)(70 * rv), 0, 0, 0), w0 + 0.8f);
    sh.SetStartCap(Gdiplus::LineCapRound); sh.SetEndCap(Gdiplus::LineCapRound);
    g.DrawLine(&sh, cx - arm + off, cy - arm + off, cx + arm + off, cy + arm + off);
    g.DrawLine(&sh, cx + arm + off, cy - arm + off, cx - arm + off, cy + arm + off);
    Gdiplus::Pen pen(Gdiplus::Color((int)(255 * rv), col.GetRed(), col.GetGreen(), col.GetBlue()), w0);
    pen.SetStartCap(Gdiplus::LineCapRound); pen.SetEndCap(Gdiplus::LineCapRound);
    g.DrawLine(&pen, cx - arm, cy - arm, cx + arm, cy + arm);
    g.DrawLine(&pen, cx + arm, cy - arm, cx - arm, cy + arm);
    if (scale > 1.001f) g.ResetTransform();
}

static LRESULT CALLBACK GlassProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    GlassCtrl* c = (GlassCtrl*)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    switch (msg) {
        case WM_NCCREATE: {
            c = (GlassCtrl*)((CREATESTRUCTW*)lp)->lpCreateParams;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)c);
            return TRUE;
        }
        case WM_PAINT: { PAINTSTRUCT ps; HDC dc = BeginPaint(hwnd, &ps); DrawGlass(dc, *c); EndPaint(hwnd, &ps); return 0; }
        case WM_ERASEBKGND: return 1;
        // ✕ 按钮自己处理鼠标（胶囊是 WS_DISABLED，点击穿透到下面 RDP 窗口）
        case WM_MOUSEMOVE: if (!c->isHint) { c->hot = true; InvalidateRect(hwnd, nullptr, FALSE); } return 0;
        case WM_MOUSELEAVE: if (!c->isHint) { c->hot = false; c->down = false; InvalidateRect(hwnd, nullptr, FALSE); } return 0;
        case WM_LBUTTONDOWN: if (!c->isHint) { c->down = true; InvalidateRect(hwnd, nullptr, FALSE); } return 0;
        case WM_LBUTTONUP:
            if (!c->isHint) {
                bool fire = c->down;
                c->down = false; c->hot = false;
                InvalidateRect(hwnd, nullptr, FALSE);
                if (fire) PostMessage(GetParent(hwnd), WM_CLOSE, 0, 0);
            }
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

// 子窗口按 DPI 定位（复刻 UpdateChromePos：胶囊居中、✕ 右上角）
static void layoutGlassControls() {
    if (!g_hwnd) return;
    RECT rc; GetClientRect(g_hwnd, &rc);
    double dpi = dpiScaleFor(g_hwnd);
    int hw = (int)(Cfg::HintW * dpi), hh = (int)(Cfg::HintH * dpi);
    int hx = (rc.right - hw) / 2, hy = (rc.bottom - hh) / 2;
    g_hintRc = { hx, hy, hx + hw, hy + hh };
    int cs = (int)(18 * dpi), ins = (int)(8 * dpi);
    g_closeRc = { rc.right - cs - ins, ins, rc.right - ins, ins + cs };
    if (g_hint.hwnd) {
        MoveWindow(g_hint.hwnd, g_hintRc.left, g_hintRc.top, g_hintRc.right - g_hintRc.left, g_hintRc.bottom - g_hintRc.top, TRUE);
        int d = g_hintRc.bottom - g_hintRc.top;
        HRGN rg = CreateRoundRectRgn(0, 0, g_hintRc.right - g_hintRc.left + 1, g_hintRc.bottom - g_hintRc.top + 1, d, d);
        SetWindowRgn(g_hint.hwnd, rg, TRUE);   // 胶囊：两端半圆
    }
    if (g_close.hwnd) {
        MoveWindow(g_close.hwnd, g_closeRc.left, g_closeRc.top, g_closeRc.right - g_closeRc.left, g_closeRc.bottom - g_closeRc.top, TRUE);
        HRGN rg = CreateEllipticRgn(0, 0, g_closeRc.right - g_closeRc.left + 1, g_closeRc.bottom - g_closeRc.top + 1);
        SetWindowRgn(g_close.hwnd, rg, TRUE);  // 圆形
    }
}
static void CreateGlassControls(HWND parent) {
    static bool reg = false;
    if (!reg) {
        WNDCLASSW wc{}; wc.lpfnWndProc = GlassProc; wc.hInstance = g_hInst; wc.lpszClassName = L"FulingGlassCtrl";
        RegisterClassW(&wc); reg = true;
    }
    g_hint.isHint = true;
    g_hint.hwnd = CreateWindowExW(0, L"FulingGlassCtrl", L"", WS_CHILD | WS_DISABLED, 0, 0, 40, 24, parent, nullptr, g_hInst, &g_hint);
    g_close.isHint = false;
    g_close.hwnd = CreateWindowExW(0, L"FulingGlassCtrl", L"", WS_CHILD, 0, 0, 18, 18, parent, nullptr, g_hInst, &g_close);
    // 让两个覆盖层位于 RDP 子窗口之上
    if (g_hint.hwnd) SetWindowPos(g_hint.hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    if (g_close.hwnd) SetWindowPos(g_close.hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    layoutGlassControls();
}
static void UpdateGlassVisibility() {
    // reveal 归零且不再需要显示 → 隐藏（避免抓帧时把覆盖层自己也抓进去）
    if (g_hint.hwnd) ShowWindow(g_hint.hwnd, (g_hint.show || g_hint.reveal > 0.005f) ? SW_SHOWNA : SW_HIDE);
    if (g_close.hwnd) ShowWindow(g_close.hwnd, (g_close.show || g_close.reveal > 0.005f) ? SW_SHOWNA : SW_HIDE);
}

// 复刻 ChromeReveal：16ms 步进，Value += d*0.32（约 130ms 淡入淡出）
static void revealStep() {
    bool dirty = false;
    float th = g_hint.show ? 1.0f : 0.0f;
    float d = th - g_hint.reveal;
    if (fabsf(d) > 0.005f) { g_hint.reveal += d * 0.32f; dirty = true; } else g_hint.reveal = th;
    float tc = g_close.show ? 1.0f : 0.0f;
    d = tc - g_close.reveal;
    if (fabsf(d) > 0.005f) { g_close.reveal += d * 0.32f; dirty = true; } else g_close.reveal = tc;
    if (dirty) {
        if (g_hint.hwnd) InvalidateRect(g_hint.hwnd, nullptr, FALSE);
        if (g_close.hwnd) InvalidateRect(g_close.hwnd, nullptr, FALSE);
    }
    UpdateGlassVisibility();
    if (!g_hint.show && !g_close.show && g_hint.reveal <= 0.005f && g_close.reveal <= 0.005f)
        KillTimer(g_hwnd, TID_REVEAL);
}

// 复刻 PollHover：60ms 轮询光标是否在小窗内 → 显示/隐藏中央胶囊 + ✕
static void hoverStep() {
    POINT cur; GetCursorPos(&cur);
    RECT wrc; GetWindowRect(g_hwnd, &wrc);
    bool inside = !g_large
        && cur.x >= wrc.left && cur.x < wrc.right && cur.y >= wrc.top && cur.y < wrc.bottom;
    if (inside != g_hovering) {
        g_hovering = inside;
        if (inside) {
            // 显示前抓玻璃底（此时 reveal=0、覆盖层未画出 → 无自反馈），复刻 CaptureHintGlass/CaptureCloseGlass
            layoutGlassControls();
            g_hint.glass = CaptureGlass(g_hintRc.left, g_hintRc.top, g_hintRc.right - g_hintRc.left, g_hintRc.bottom - g_hintRc.top, 5);
            g_close.glass = CaptureGlass(g_closeRc.left, g_closeRc.top, g_closeRc.right - g_closeRc.left, g_closeRc.bottom - g_closeRc.top, 4);
            g_hint.show = g_close.show = true;
            SetTimer(g_hwnd, TID_REVEAL, 16, nullptr);
        } else {
            g_hint.show = g_close.show = false;
        }
    }
    if (inside) {
        POINT p = cur; ScreenToClient(g_hwnd, &p);
        bool hh = InRect(g_hintRc, p.x, p.y), hc = InRect(g_closeRc, p.x, p.y);
        if (hh != g_hint.hot || hc != g_close.hot) {
            g_hint.hot = hh; g_close.hot = hc;
            if (g_hint.hwnd) InvalidateRect(g_hint.hwnd, nullptr, FALSE);
            if (g_close.hwnd) InvalidateRect(g_close.hwnd, nullptr, FALSE);
        }
    }
}

// 把 RDP 内部渲染面（IHWindowClass / OPContainerClass / UIContainerClass）钉到目标尺寸。
// 【背景】MSTSC 内部自建多个窗口，其中真正承载画面的是会话分辨率尺寸（1280x720 在
// 150% DPI 下被折算成 853x480）。窗口放大后这些内层窗口不会自动拉伸，画面就被按会话
// 分辨率摆在中间，四周露出宿主底色（用户看到的"放大到一定程度出现空白"）。
//
// 【关键：只能改尺寸，绝不能改位置】
//   · 必须【每帧】调用一次：MSTSC 在内部布局/重绘时会异步把内层复位回会话分辨率，
//     只在"外层尺寸不匹配"时调用是无效的 —— 外层一对上就再没人管内层了。
//   · 必须保留 SWP_NOMOVE：这些窗口的父容器不是我们直接控制的客户区，强行传 (0,0)
//     是相对【父容器】的坐标，会把渲染面推到左上角、右下整片露出宿主底色。
//     实测踩过：客户区 1065x600 时画面被钉在左上角，右/下全黑。
//     位置交给 MSTSC 的 SmartSizing 处理，我们只负责把"可用尺寸"喂对。
//   · 尺寸已对得上就跳过：SetWindowPos 会触发 MSTSC 重排 + 重绘，无差别调用会跟着
//     32ms 定时器持续抖动（CPU 飙升 + 闪烁）。
static BOOL CALLBACK RdpChildScale(HWND h, LPARAM l) {
    wchar_t cls[128]; GetClassNameW(h, cls, 128);
    if (wcsstr(cls, L"IHWindowClass") || wcsstr(cls, L"OPContainerClass") ||
        wcsstr(cls, L"UIContainerClass")) {
        RECT* rc = (RECT*)l;
        int w = rc->right - rc->left, hgt = rc->bottom - rc->top;
        RECT cur; GetWindowRect(h, &cur);
        // 容差 2px：MSTSC 偶发把内层复位回会话分辨率时按 1px 抖动，用精确 == 会反复
        // SetWindowPos → 触发 MSTSC 重排/重绘 → 跟随 32ms 定时器持续抖动。2px 内视为已铺满。
        int cw = cur.right - cur.left, chh = cur.bottom - cur.top;
        if (abs(cw - w) < 2 && abs(chh - hgt) < 2) return TRUE;
        SetWindowPos(h, nullptr, 0, 0, w, hgt, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
    return TRUE;
}

// ===== 小窗拖动（对齐 C# BeginDrag/DoDrag/EndDrag）=====
static void BeginDrag() {
    POINT p; GetCursorPos(&p);
    g_dragging = true;
    g_dragStartMouse = p;
    RECT rc; GetWindowRect(g_hwnd, &rc);
    g_dragStartWnd = { rc.left, rc.top };
}
static void DoDrag() {
    if (!g_dragging) return;
    POINT p; GetCursorPos(&p);
    SetWindowPos(g_hwnd, nullptr,
        g_dragStartWnd.x + (p.x - g_dragStartMouse.x),
        g_dragStartWnd.y + (p.y - g_dragStartMouse.y),
        0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}
static void EndDrag() { g_dragging = false; }

// ===== RDP 输入窗口子类化钩子（复刻 C# AxHookProc）=====
// RDP ActiveX 内部按会话分辨率（1280x720）建了多个输入窗口（IHWindowClass /
// OPContainerClass / UIContainerClass），横跨整个可见画面，鼠标消息全被它们吃掉，
// 主窗口的 WM_NCHITTEST / WM_LBUTTONDOWN 根本收不到 —— 这就是"点击穿透进远端"、
// "长按空白处拖不动"的根因。给这些窗口挂钩子：小窗形态下吃掉鼠标/键盘、
// 点胶囊放大、点别处长按拖动；大窗形态原样放行（正常操作远端）。
static std::unordered_map<HWND, WNDPROC> g_axHooks;

static LRESULT CALLBACK AxHookProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    auto it = g_axHooks.find(hwnd);
    WNDPROC orig = it != g_axHooks.end() ? it->second : nullptr;
    auto pass = [&] {
        return orig ? CallWindowProcW(orig, hwnd, msg, wp, lp)
                    : DefWindowProcW(hwnd, msg, wp, lp);
    };
    switch (msg) {
        case WM_MOUSEACTIVATE:
            // 小窗：纯预览不激活（不抢主窗口焦点）
            if (!g_large) return MA_NOACTIVATE;
            break;
        case WM_SETCURSOR:
            // 小窗：光标固定箭头（远端不显示自己的光标）
            if (!g_large) { SetCursor(LoadCursor(nullptr, IDC_ARROW)); return 1; }
            break;
        case WM_KEYDOWN: case WM_KEYUP: case WM_SYSKEYDOWN: case WM_SYSKEYUP:
        case WM_CHAR: case WM_SYSCHAR: case WM_IME_CHAR:
            // 小窗：物理键盘不进分身
            if (!g_large) return 0;
            break;
        case WM_LBUTTONDOWN: {
            if (!g_large) {
                int lx = (short)LOWORD(lp), ly = (short)HIWORD(lp);
                bool onHint = InRect(g_hintRc, lx, ly);   // 点胶囊 → 放大成大窗
                if (onHint) SetLarge(true);
                else BeginDrag();                          // 点别处 → 长按拖动
                return 0;
            }
            break;
        }
        case WM_MOUSEMOVE:
            if (!g_large) { if (g_dragging) DoDrag(); return 0; }
            break;
        case WM_LBUTTONUP:
            if (!g_large) { EndDrag(); return 0; }
            break;
        case WM_RBUTTONDOWN: case WM_RBUTTONUP:
        case WM_MBUTTONDOWN: case WM_MBUTTONUP:
        case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL:
        case WM_XBUTTONDOWN: case WM_XBUTTONUP:
            // 小窗：一切鼠标输入吃掉（不注入远端）
            if (!g_large) return 0;
            break;
        case WM_NCLBUTTONDOWN:
            // 小窗：非客户区按下吃掉
            if (!g_large) return 0;
            break;
        case WM_LBUTTONDBLCLK: case WM_NCLBUTTONDBLCLK:
            // 小窗：双击剥离成大窗（吃掉，不转发给远端程序）
            if (!g_large) { SetLarge(true); return 1; }
            break;
        default:
            break;
    }
    return pass();
}

// 周期枚举 RDP 输入窗口并确保全部挂上 AxHook（RDP 连接/重连/换分辨率时会重建句柄）
static BOOL CALLBACK AxHookEnumChild(HWND h, LPARAM lp) {
    wchar_t cls[128]; GetClassNameW(h, cls, 128);
    if (wcsstr(cls, L"IHWindowClass") || wcsstr(cls, L"OPContainerClass") ||
        wcsstr(cls, L"UIContainerClass")) {
        if (g_axHooks.find(h) == g_axHooks.end()) {
            WNDPROC prev = (WNDPROC)SetWindowLongPtrW(h, GWLP_WNDPROC, (LONG_PTR)AxHookProc);
            g_axHooks[h] = prev ? prev : nullptr;
        }
    }
    return TRUE;
}
static void WatchAx() {
    if (!g_rdpHwnd) return;
    EnumChildWindows(g_rdpHwnd, AxHookEnumChild, 0);
    // 顺手清理已销毁窗口的残留（可选，避免 map 无限增长）
    if (g_axHooks.size() > 64) {
        for (auto it = g_axHooks.begin(); it != g_axHooks.end();) {
            if (!IsWindow(it->first)) it = g_axHooks.erase(it); else ++it;
        }
    }
}


static void ApplyTheme(bool dark);   // 前向声明（定义在 SetLarge 前）

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_CREATE: {
            g_hwnd = hwnd;
            // 系统标题栏显示标题 + logo 图标（大窗时系统原生标题栏；图标按主题：深色=粉色、浅色=黑色）
            SetWindowTextW(hwnd, L"浮灵饰界 · 桌面分身");
            ApplyTheme(g_cfg.theme != L"light");
            SetAcrylic(hwnd);
            layoutChrome();
            g_bgBrush = CreateSolidBrush(RGB(18,20,26));   // 未连接黑底
            g_status->connecting();
            // 托管 RDP ActiveX
            if (g_rdp.CreateInWindow(hwnd)) {
                g_rdp.onLogin = []{ g_rdpConnected=true; g_rdpPainted=true; g_status->hwnd(g_hwnd); log("rdp login complete"); };
                g_rdp.onDisconnect = [](int r){ if(g_rdpConnected) g_status->note(L"STATE failed|RDP 连接断开:"+std::to_wstring(r)); };
                g_rdp.onFatal     = [](int c){ g_status->failed(L"RDP 客户端致命错误:"+std::to_wstring(c)); };
                g_rdp.onLogonError= [](int c){ g_status->failed(L"RDP 登录失败:"+std::to_wstring(c)); };
                // 连接前先把 RDP 外层窗口钉到客户区：RDP 连接时会按当时的控件尺寸锁定
                // 渲染表面（IHWindowClass）。若连接时外层还是大尺寸，之后 SetWindowPos 只缩外层、
                // 内部渲染表面保持 853x480 → 预览只能看到桌面一角（C# 版控件初始就是客户区所以正常）。
                RECT rc0; GetClientRect(hwnd, &rc0);
                g_rdp.Reacquire();
                if (g_rdpHwnd) {
                    SetWindowPos(g_rdpHwnd, nullptr, 0, 0,
                        rc0.right - rc0.left, rc0.bottom - rc0.top,
                        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
                }
                // 会话分辨率跟随宿主所在显示器（物理像素）：
                // MSTSC SmartSizing 只能缩小、不能放大。若沿用固定 1280x720，窗口拉大后
                // 画面不会铺满，而是停在原分辨率居中露黑底（即"放大不能铺满"）。
                // 设为显示器分辨率后：窗口最大=显示器 ≤ 会话，永远只需缩小；
                // 会话宽高比=屏幕宽高比，窗口拉多大画面都等比铺满、不变形。
                HMONITOR mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                MONITORINFO mi; mi.cbSize = sizeof(mi);
                int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
                if (mon && GetMonitorInfoW(mon, &mi)) {
                    sw = mi.rcMonitor.right - mi.rcMonitor.left;
                    sh = mi.rcMonitor.bottom - mi.rcMonitor.top;
                }
                g_cfg.desktopW = std::max(200, std::min(sw, 8192));
                g_cfg.desktopH = std::max(200, std::min(sh, 8192));
                g_rdp.Connect(g_cfg);
                log("rdp connect issued");
            } else {
                g_status->failed(L"RDP ActiveX 初始化失败");
                log("rdp activex init FAILED");
            }
            // 毛玻璃悬停覆盖层（在 RDP 子窗口之上）
            CreateGlassControls(hwnd);
            UpdateGlassVisibility();
            SetTimer(hwnd, TID_HOVER, 60, nullptr);
            // 等比缩放贴合循环（对齐 C# _resizeWatch 32ms）：RDP 激活后渲染窗口初始是
            // 1024x576（GetWindowContext），需周期性强制 Resize 到客户区 + RedrawWindow，
            // 让 SmartSizing 位图贴合客户区 → 完整等比桌面。
            SetTimer(hwnd, TID_RDPSCALE, 32, nullptr);
            return 0;
        }
        case WM_SIZE: {
            RECT rc; GetClientRect(hwnd, &rc);
            layoutChrome();
            layoutGlassControls();
            UpdateGlassVisibility();
            return 0;
        }
        case WM_ERASEBKGND:
            // 未连上前给整个客户区垫黑底（大窗用系统原生标题栏，客户区全是画面，无自绘标题栏条）
            if (!g_rdpPainted) {
                RECT rc; GetClientRect(hwnd,&rc);
                FillRect((HDC)wp,&rc,g_bgBrush);
                return 1;
            }
            return 1;
        case WM_PAINT: {
            PAINTSTRUCT ps; HDC dc = BeginPaint(hwnd, &ps);
            if (!g_rdpPainted) {
                RECT rc; GetClientRect(hwnd, &rc);
                FillRect(dc, &rc, g_bgBrush);
            }
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_NCHITTEST: {
            int sx = GET_X_LPARAM(lp), sy = GET_Y_LPARAM(lp);
            // 大窗用【系统原生标题栏】：命中测试完全交回系统默认处理，它自己认得
            // 标题栏拖动 / 最小化 / 最大化 / 关闭按钮 / 缩放边框。
            if (g_large) break;
            // 小窗=无边框：自定义命中（顶部区拖动 / 其余客户区）
            return HitTest(sx, sy);
        }
        case WM_NCLBUTTONDOWN: {
            // 大窗：交回系统处理标题栏拖动与边缘缩放
            if (g_large) break;
            int ht = wp;
            if (ht>=HTLEFT && ht<=HTBOTTOMRIGHT) {
                // 系统原生缩放循环（有 WS_THICKFRAME）
                ReleaseCapture();
                SendMessage(hwnd, WM_SYSCOMMAND, 0xF000 | ht, 0);
                return 0;
            }
            if (ht==HTCAPTION) { /* 交给系统拖动 */ }
            break;
        }
        case WM_LBUTTONDOWN: {
            // 大窗：标题栏与按钮都在非客户区，由系统处理；客户区的点击交给 RDP 子窗口
            if (g_large) break;
            break;
        }
        case WM_ENTERSIZEMOVE:
            // 用户开始拖拽缩放（或拖动大窗）大窗：停掉 32ms 强制缩放循环，
            // 否则它每 32ms 对 RDP 子窗口 SetWindowPos/Resize/Redraw，与系统缩放循环
            // 和 SmartSizing 打架 → 放大时持续抖动。拖拽期间由 WM_SIZE → layoutChrome 即时铺满。
            g_sizing = true;
            if (g_large) KillTimer(hwnd, TID_RDPSCALE);
            return 0;
        case WM_EXITSIZEMOVE:
            g_sizing = false;
            if (g_large) {
                layoutChrome();     // 松手后一次性铺满贴合到最终客户区
                RedrawWindow(hwnd, nullptr, nullptr,
                    RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
                SetTimer(hwnd, TID_RDPSCALE, 32, nullptr);
            }
            return 0;
        case WM_SIZING: {
            // 大窗缩放：锁定"客户区（== 画面区）宽高比 == 远端画面比例"。
            // 系统原生标题栏在非客户区，其高度已包含在实测边框差 fh 里，不需要再减。
            if (!g_large) break;
            RECT* prc = (RECT*)lp;
            int w = prc->right - prc->left, h = prc->bottom - prc->top;
            RECT wr, cr; GetWindowRect(hwnd, &wr); GetClientRect(hwnd, &cr);
            int fw = (wr.right-wr.left) - (cr.right-cr.left);   // 左右可缩放边框总宽
            int fh = (wr.bottom-wr.top) - (cr.bottom-cr.top);   // 上下边框 + 系统标题栏高度
            int cw = w - fw; if (cw < 1) cw = 1;
            int ch = h - fh; if (ch < 1) ch = 1;
            double aspect = (double)g_cfg.desktopH / (double)g_cfg.desktopW;
            int edge = (int)wp;
            if (edge == WMSZ_LEFT || edge == WMSZ_RIGHT) {
                if (edge == WMSZ_LEFT) prc->left = prc->right - w;
                prc->bottom = prc->top + (int)(cw * aspect + 0.5) + fh;
            } else if (edge == WMSZ_TOP || edge == WMSZ_BOTTOM) {
                if (edge == WMSZ_TOP) prc->top = prc->bottom - h;
                prc->right = prc->left + (int)(ch / aspect + 0.5) + fw;
            } else {
                prc->bottom = prc->top + (int)(cw * aspect + 0.5) + fh;   // 角：宽度主导
            }
            return 1;
        }
        case WM_NCLBUTTONDBLCLK:
            // 标题栏双击：交回系统默认（最大化/还原）
            break;
        case WM_SYSCOMMAND:
            // 大窗系统标题栏的「—」最小化：不缩到任务栏（本窗不进任务栏，缩下去找不回来），
            // 而是收回成悬浮预览小窗（对齐 C# WndProc 的 SC_MINIMIZE 处理）。
            if (g_large && (wp & 0xFFF0) == SC_MINIMIZE) { SetLarge(false); return 0; }
            break;
        case WM_LBUTTONDBLCLK:
            // 小窗双击剥离成大窗
            if (!g_large) { SetLarge(true); return 0; }
            break;
        case WM_MOUSEACTIVATE:
            return g_cfg.nofocus ? MA_NOACTIVATE : MA_ACTIVATE;
        case WM_NCACTIVATE:
            // 保持"激活"标题栏外观（对齐 C#）：否则 inactive 状态下系统把标题栏/关闭按钮画成
            // 灰暗/红色，看起来就像"✕ 一直是红的"。
            return 1;
        case WM_TIMER:
            if (wp == TID_REVEAL) revealStep();
            else if (wp == TID_HOVER) hoverStep();
            else if (wp == TID_RDPSCALE) {
                if (g_sizing) return 0;   // 用户拖拽缩放中：交给 WM_SIZE/layoutChrome，避免强制循环打架
                // RDP 激活回调里 GetWindow 常为空 → 周期性重新获取子窗口（对齐 C# _axWatch）
                if (!g_rdpHwnd) g_rdp.Reacquire();
                // 周期给 RDP 输入窗口挂鼠标钩子（复刻 C# WatchAx；小窗拖动/吃点击依赖它）
                WatchAx();
                if (g_rdpHwnd) {
                    RECT rc; GetClientRect(hwnd, &rc);
                    RECT cr; GetClientRect(g_rdpHwnd, &cr);
                    int cw = cr.right - cr.left, ch = cr.bottom - cr.top;
                    // 大窗用系统原生标题栏（位于非客户区），客户区整块都是画面 → 期望 (0,0)+全尺寸。
                    int ww = rc.right - rc.left, wh = rc.bottom - rc.top;
                    // 位置也要校验：连接前 RDP 被钉在 (0,0) 铺满客户区，若只查尺寸，
                    // 一旦尺寸恰好对上就永远不再纠正 → 画面偏移（曾出现顶部一条无用空白/遮挡）。
                    RECT rr; GetWindowRect(g_rdpHwnd, &rr);
                    POINT rtop = { rr.left, rr.top };
                    ScreenToClient(hwnd, &rtop);
                    bool posBad = (rtop.x != 0 || rtop.y != 0);
                    // 容差 1px：避免 MSTSC/SmartSizing 的亚像素差异触发无谓重排抖动
                    bool outerBad = (abs(cw - ww) > 1 || abs(ch - wh) > 1 || posBad);
                    if (outerBad) {
                        RECT rdp = { 0, 0, rc.right, rc.bottom };
                        SetWindowPos(g_rdpHwnd, nullptr, rdp.left, rdp.top,
                                     rdp.right-rdp.left, rdp.bottom-rdp.top,
                                     SWP_NOZORDER | SWP_NOACTIVATE);
                        g_rdp.Resize(rdp);
                    }
                    // 【修复放大后出现空白】内层渲染面必须【每帧】钉到客户区，不能只在
                    // outerBad 时才做：MSTSC 会在内部布局/重绘时把 IHWindowClass 等
                    // 复位成会话分辨率（853x480）。外层一旦对得上就再没人管内层，
                    // 窗口放大超过 853 宽后画面被居中、四周露出灰底空白。
                    // RdpChildScale 内部只在尺寸真的不符时才 SetWindowPos，不会抖动。
                    RECT inner = { 0, 0, rc.right, rc.bottom };
                    EnumChildWindows(g_rdpHwnd, RdpChildScale, (LPARAM)&inner);
                    if (outerBad) {
                        RedrawWindow(hwnd, nullptr, nullptr,
                            RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
                    }
                }
            }
            return 0;
        case WM_CLOSE: {
            g_closing = true;
            g_rdp.Disconnect();
            g_status->closed();
            if (g_rdpHwnd) DestroyWindow(g_rdpHwnd);
            DestroyWindow(hwnd);
            return 0;
        }
        case WM_DESTROY: {
            g_running = false;
            KillTimer(hwnd, TID_REVEAL);
            KillTimer(hwnd, TID_HOVER);
            KillTimer(hwnd, TID_RDPSCALE);
            if (g_hint.hwnd) DestroyWindow(g_hint.hwnd);
            if (g_close.hwnd) DestroyWindow(g_close.hwnd);
            if (g_bgBrush) DeleteObject(g_bgBrush);
            PostQuitMessage(0);
            return 0;
        }
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

// 打包程序图标：统一使用 icon.ico（IDI_APP），不区分主题、不用 logo 系列。
// 按窗口 DPI 加载标题栏小/大图标对应物理尺寸，避免 Windows 二次缩放导致模糊。
static HICON LoadResIconAt(int id, int px) {
    return (HICON)LoadImageW(g_hInst, MAKEINTRESOURCEW(id), IMAGE_ICON, px, px, LR_DEFAULTCOLOR);
}

// 应用主题：dark → DWM 深色标题栏；light → DWM 浅色标题栏。图标统一用 icon.ico。
// 对齐 C# ApplyTheme：换图标后 RedrawWindow(RDW_FRAME) 强刷非客户区。
static void ApplyTheme(bool dark) {
    int dm = dark ? 1 : 0;
    DwmSetWindowAttribute(g_hwnd, 20, &dm, sizeof(dm));   // DWMWA_USE_IMMERSIVE_DARK_MODE

    UINT dpi = GetDpiForWindow(g_hwnd);
    int smPx = MulDiv(16, (int)dpi, 96);   // 标题栏小图标物理尺寸（150% 屏 = 24px）
    int bgPx = MulDiv(48, (int)dpi, 96);   // Alt-Tab / 大图标物理尺寸
    HICON niSm = LoadResIconAt(IDI_APP, smPx);
    HICON niBg = LoadResIconAt(IDI_APP, bgPx);
    if (niSm || niBg) {
        HICON oldSm = g_titleIconSm, oldBg = g_titleIconBg;
        g_titleIconSm = g_titleIconBg = nullptr;
        if (oldSm) DestroyIcon(oldSm);
        if (oldBg && oldBg != oldSm) DestroyIcon(oldBg);
        if (!niSm) niSm = niBg;
        if (!niBg) niBg = niSm;
        g_titleIconSm = niSm;
        g_titleIconBg = niBg;
        SendMessageW(g_hwnd, WM_SETICON, ICON_SMALL, (LPARAM)niSm);
        SendMessageW(g_hwnd, WM_SETICON, ICON_BIG,   (LPARAM)niBg);
        RedrawWindow(g_hwnd, nullptr, nullptr, 0x0040 | 0x0001 | 0x0004);  // RDW_FRAME|RDW_INVALIDATE|RDW_UPDATENOW
    }
    // 主题切换：强刷非客户区（系统标题栏）+ 客户区
    InvalidateRect(g_hwnd, nullptr, TRUE);
    RedrawWindow(g_hwnd, nullptr, nullptr, RDW_FRAME | RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
    // 毛玻璃 tint 随主题：重设 acrylic，让标题栏模糊色调与深浅主题一致
    SetAcrylic(g_hwnd);
}

// 系统主题检测（AppsUseLightTheme）：0=深色，1=浅色；读不到时按深色。
static bool SystemDarkTheme() {
    DWORD v = 1, sz = sizeof(v);
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER,
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
            0, KEY_READ, &k) == ERROR_SUCCESS) {
        if (RegQueryValueExW(k, L"AppsUseLightTheme", nullptr, nullptr, (LPBYTE)&v, &sz) != ERROR_SUCCESS) v = 1;
        RegCloseKey(k);
    }
    return v == 0;
}

static void SetLarge(bool large) {
    if (g_large == large) return;
    g_large = large;
    // 边框/标题栏随形态切换（对齐 C# ApplyWindowFrameForMode，只改样式位不重建 HWND，
    // 否则 RDP ActiveX 子窗口全销毁 → 连接必断）：
    //   · 大窗 = **系统原生标题栏**（用户明确"用系统的不要自制的"）：标题+图标+最小化+关闭+可缩放边框；
    //   · 小窗 = 彻底无边框弹窗（连 WS_THICKFRAME 也去掉，固定尺寸）。
    LONG st = GetWindowLongPtrW(g_hwnd, GWL_STYLE);
    const LONG TITLEBAR = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
    if (large) {
        // 大窗 = **系统原生标题栏**（不要自制 -/✕）：保留 WS_CAPTION|WS_SYSMENU|
        // WS_MINIMIZEBOX|WS_MAXIMIZEBOX|WS_THICKFRAME，由系统绘制图标 + 标题文字 +
        // 最小化/最大化/关闭按钮（外观、hover、键盘可达性全部原生且随主题）。
        // 客户区从标题栏下方开始（bar 由系统标题栏高度决定），RDP 画面不再自绘标题栏。
        st |= TITLEBAR;
    }
    else       { st &= ~TITLEBAR; st |= WS_POPUP; }
    SetWindowLongPtrW(g_hwnd, GWL_STYLE, st);
    // 扩展样式随形态（对齐 C# ApplyOwnerForMode）：
    //   · 大窗 = 独立顶层窗口（WS_EX_APPWINDOW，占任务栏、可抢焦点）——否则系统标题栏
    //     不会渲染 —/✕ 按钮（工具窗口样式只给 ✕，且无最小化）。
    //   · 小窗 = 工具窗（WS_EX_TOOLWINDOW，不占任务栏）+ 不抢焦点。
    LONG ex = GetWindowLongPtrW(g_hwnd, GWL_EXSTYLE);
    if (large) { ex |= WS_EX_APPWINDOW; ex &= ~(LONG)(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE); }
    else       { ex &= ~(LONG)WS_EX_APPWINDOW; ex |= WS_EX_TOOLWINDOW; if (g_cfg.nofocus) ex |= WS_EX_NOACTIVATE; }
    SetWindowLongPtrW(g_hwnd, GWL_EXSTYLE, ex);
    int w = large ? Cfg::LargeW : Cfg::SmallW;
    int h = Cfg::SmallH;
    RECT rc; GetWindowRect(g_hwnd,&rc);
    int x = rc.left, y = rc.top;

    if (large) {
        // 大窗高 = 画面高（16:9）+ 系统非客户区高度（系统标题栏 + 上下边框）。
        // 注意：样式刚改完时 GetClientRect 还是旧边框，必须先 SWP_FRAMECHANGED 走一遍，
        // 让系统按新样式重算非客户区，再实测 fw/fh 差值，否则高度会算错（原 bug）。
        SetWindowPos(g_hwnd, HWND_TOPMOST, x, y, w, h, SWP_FRAMECHANGED | SWP_NOACTIVATE);
        RECT wr, cr; GetWindowRect(g_hwnd, &wr); GetClientRect(g_hwnd, &cr);
        int fw = (wr.right-wr.left) - (cr.right-cr.left);
        int fh = (wr.bottom-wr.top) - (cr.bottom-cr.top);
        int vw = w - fw; if (vw < 1) vw = 1;
        h = (int)(vw * (double)g_cfg.desktopH / g_cfg.desktopW + 0.5) + fh;
    }
    SetWindowPos(g_hwnd, HWND_TOPMOST, x, y, w, h, SWP_FRAMECHANGED | SWP_NOACTIVATE);
    layoutChrome();
    // 圆角：两种形态都用 Win11 圆角（DWMWCP_ROUND），与系统标题栏风格一致
    int corner = 2;   // DWMWCP_ROUND
    DwmSetWindowAttribute(g_hwnd, 33, &corner, sizeof(corner));
    // 尺寸/样式定稿后重设毛玻璃：大窗由系统把原生标题栏画成亚克力；
    // 小窗由 DwmExtendFrameIntoClientArea 把亚克力铺满客户区。
    SetAcrylic(g_hwnd);
    // 大窗：激活窗口 + 强制按"激活"绘制标题栏 —— 否则标题栏按钮用 inactive 浅色，
    // 浅色主题下按钮浅灰几乎看不见（用户反馈"浅色背景按钮没变黑看不见"）。
    if (large) {
        if (!g_cfg.nofocus) {
            SetWindowPos(g_hwnd, HWND_TOPMOST, x, y, w, h, SWP_FRAMECHANGED);
            SetActiveWindow(g_hwnd);
            BringWindowToTop(g_hwnd);
            SetForegroundWindow(g_hwnd);
        }
        PostMessageW(g_hwnd, WM_NCACTIVATE, 1, 0);   // 强制重绘为 active 标题栏（按钮深色可见）
    }
    // 大窗不显示悬停覆盖层
    if (large) {
        g_hint.show = g_close.show = false;
        g_hint.reveal = g_close.reveal = 0;
        g_hovering = false;
        if (g_hint.hwnd) ShowWindow(g_hint.hwnd, SW_HIDE);
        if (g_close.hwnd) ShowWindow(g_close.hwnd, SW_HIDE);
    }
    InvalidateRect(g_hwnd,nullptr,TRUE);
}

// ============================================================================
// 命令行解析（与 desktopSession.js args 对齐）
// ============================================================================
static int g_argc;
static wchar_t** g_argv;
static std::wstring getArg(const wchar_t* key) {
    for (int i=1;i<g_argc-1;i++) if (_wcsicmp(g_argv[i],key)==0) return g_argv[i+1];
    return L"";
}
static bool hasFlag(const wchar_t* key) {
    for (int i=1;i<g_argc;i++) if (_wcsicmp(g_argv[i],key)==0) return true;
    return false;
}
static void parseArgs(HostConfig& c) {
    std::wstring s;
    if ((s=getArg(L"--server")).size()) c.server = s;
    if ((s=getArg(L"--desktop")).size()) { swscanf(s.c_str(), L"%dx%d", &c.desktopW, &c.desktopH); }
    if ((s=getArg(L"--theme")).size()) c.theme = s;
    // 未指定 --theme：随系统主题（AppsUseLightTheme），标题栏配色/logo 跟随深浅色
    if (c.theme.empty()) c.theme = SystemDarkTheme() ? L"dark" : L"light";
    if ((s=getArg(L"--accent")).size()) c.accent = s;
    if ((s=getArg(L"--themeFile")).size()) c.themeFile = s;
    if ((s=getArg(L"--status")).size()) c.statusFile = s;
    if ((s=getArg(L"--cmd")).size()) c.cmdFile = s;
    if ((s=getArg(L"--logo")).size()) c.logoFile = s;
    if (hasFlag(L"--small")) c.startSmall = true;
    if (hasFlag(L"--nofocus")) c.nofocus = true;
    if ((s=getArg(L"--pos")).size()) swscanf(s.c_str(), L"%dx%d", &c.posX, &c.posY);
    if ((s=getArg(L"--owner")).size()) c.ownerHwnd = (HWND)(intptr_t)_wtoi64(s.c_str());
    if ((s=getArg(L"--parent-pid")).size()) c.parentPid = (DWORD)_wtoi(s.c_str());
    if ((s=getArg(L"--pageVisible")).size()) c.pageVisible = s==L"1";
    if ((s=getArg(L"--anchor")).size()) {
        int a=0,b=0,w=0,h=0;
        if (swscanf(s.c_str(), L"%d,%d,%d,%d", &a,&b,&w,&h)==4) {
            c.anchorValid=true; c.anchorX=a; c.anchorY=b; c.anchorW=w; c.anchorH=h;
        }
    }
    if ((s=getArg(L"--anchorRight")).size()) c.anchorRight = _wtoi(s.c_str());
    if ((s=getArg(L"--port")).size()) c.port = _wtoi(s.c_str());
}

// ============================================================================
// 主入口
// ============================================================================
static void applyAnchorPos() {
    int w = Cfg::SmallW, h = Cfg::SmallH;
    int x = g_cfg.posX, y = g_cfg.posY;
    if (g_cfg.anchorValid) {
        int right = g_cfg.anchorRight >= 0 ? g_cfg.anchorRight : (g_cfg.anchorX + g_cfg.anchorW);
        x = right - w;
        y = g_cfg.anchorY - Cfg::AnchorGap - h;
    }
    SetWindowPos(g_hwnd, HWND_TOPMOST, x, y, w, h, SWP_SHOWWINDOW);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int) {
    g_hInst = hInst;
    g_argv = CommandLineToArgvW(GetCommandLineW(), &g_argc);
    // 尽早写一条日志，用于隔离启动崩溃点
    {
        wchar_t tmp[MAX_PATH]; GetTempPathW(MAX_PATH, tmp);
        std::wstring d = std::wstring(tmp)+L"fuling-rdp-clone";
        CreateDirectoryW(d.c_str(), nullptr);
        g_logPath = d + L"\\_host_log.txt";
        log("ENTER wWinMain argc=%d pid=%lu", g_argc, GetCurrentProcessId());
    }
    parseArgs(g_cfg);
    log("parseArgs done, status=%ls", g_cfg.statusFile.c_str());

    // 日志路径
    wchar_t mod[MAX_PATH]; GetModuleFileNameW(nullptr, mod, MAX_PATH);
    std::wstring base = mod;
    size_t pos = base.rfind(L'\\');
    g_logPath = computeLogPath(base.substr(0,pos));

    // 运行时数据目录 / 端口文件
    {
        wchar_t tmp[MAX_PATH]; GetTempPathW(MAX_PATH, tmp);
        std::wstring d = std::wstring(tmp) + L"fuling-rdp-clone";
        CreateDirectoryW(d.c_str(), nullptr);
        if (g_cfg.inputPortFile.empty()) g_cfg.inputPortFile = d + L"\\_input_port.txt";
    }
    log("---- native host start pid=%lu", GetCurrentProcessId());

    // PerMonitorV2
    HMODULE u = GetModuleHandleW(L"user32.dll");
    if (u) {
        typedef BOOL (WINAPI* F)(HANDLE);
        F f = (F)GetProcAddress(u, "SetProcessDpiAwarenessContext");
        if (f) f((HANDLE)(intptr_t)-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    }

    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    // GDI+（抗锯齿绘制毛玻璃胶囊 / ✕）
    Gdiplus::GdiplusStartupInput gsi;
    Gdiplus::GdiplusStartup(&g_gdiplusToken, &gsi, nullptr);

    // 状态文件
    {
        wchar_t tmp[MAX_PATH]; GetTempPathW(MAX_PATH, tmp);
        std::wstring d = std::wstring(tmp)+L"fuling-rdp-clone";
        if (g_cfg.statusFile.empty()) g_cfg.statusFile = d + L"\\_status.txt";
    }
    g_status = new StatusWriter(g_cfg.statusFile);

    // 注册窗口类
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = L"FulingCloneNativeHost";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    RegisterClassExW(&wc);

    // 小窗：彻底无边框（客户区=窗口，等比无空白，对齐 C# 小窗 FormBorderStyle.None，
    //      否则 WS_THICKFRAME 的调整边框会吃掉客户区 → 画面偏小/比例偏移/顶部空白）；
    // 大窗（不带 --small）：**自绘标题栏**（微软 TitleBar 方案：去系统标题栏，
    //      客户区顶部自绘 logo/标题/—✕按钮 + 可缩放边框，无最大化——比例锁和最大化打架，
    //      对齐 C# ApplyWindowFrameForMode）。
    LONG style = g_cfg.startSmall ? WS_POPUP
                : (WS_THICKFRAME);
    // 扩展样式随形态（对齐 C#）：大窗=独立窗口（APPWINDOW，任务栏正常）；
    // 小窗=工具窗（TOOLWINDOW，不占任务栏）+ 按 --nofocus 决定是否抢焦点。
    LONG ex = g_cfg.startSmall
              ? (WS_EX_TOOLWINDOW | (g_cfg.nofocus ? WS_EX_NOACTIVATE : 0))
              : WS_EX_APPWINDOW;

    int w = Cfg::SmallW, h = Cfg::SmallH;
    g_hwnd = CreateWindowExW(ex, wc.lpszClassName, L"桌面分身", style,
                             g_cfg.posX, g_cfg.posY, w, h,
                             nullptr, nullptr, hInst, nullptr);
    if (!g_hwnd) { log("CreateWindowEx FAILED err=%lu", GetLastError()); return 1; }

    if (g_cfg.ownerHwnd) {
        SetWindowLongPtrW(g_hwnd, GWLP_HWNDPARENT, (LONG_PTR)g_cfg.ownerHwnd);
    }

    // 圆角：创建即设 Win11 圆角（DWMWCP_ROUND）。SetLarge 里也会设，但小窗启动时
    // g_large 初始就是 false、不经过 SetLarge —— 不在这里设，开启瞬间小窗是方角，
    // 要切一次大窗才变圆角（用户反馈「开启时小窗不是圆角矩形」）。
    {
        int corner = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(g_hwnd, 33, &corner, sizeof(corner));
    }

    applyAnchorPos();

    // 启动即独立大窗（不带 --small）：放大到大窗尺寸 + 自绘标题栏。
    // 小窗（--small）保持无边框，点击胶囊放大后才上标题栏 —— 用户明确"放大之前不要"。
    if (!g_cfg.startSmall) SetLarge(true);

    // 线程
    std::thread poll(pollThread);
    std::thread tcp(tcpThread);
    poll.detach(); tcp.detach();

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    g_running = false;
    CoUninitialize();
    if (g_gdiplusToken) Gdiplus::GdiplusShutdown(g_gdiplusToken);
    return 0;
}
