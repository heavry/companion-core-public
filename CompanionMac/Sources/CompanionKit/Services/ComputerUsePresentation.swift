import Foundation

public enum ComputerUsePresentation {
    public static func statusTitle(installed: Bool, enabled: Bool, health: String, permissionsReady: Bool) -> String {
        if !installed { return health == "error" ? "Error" : "Not installed" }
        if !enabled { return "Disabled" }
        if health == "error" { return "Error" }
        if !permissionsReady { return "Needs macOS permission" }
        return "Ready"
    }

    public static let installProgress = [
        "compatibility": "正在检查兼容性",
        "download": "正在安装 Computer Use",
        "verify": "正在验证可信来源",
        "extract": "正在准备运行环境",
        "register": "正在注册能力",
        "health_check": "正在测试",
        "ready": "已就绪"
    ]

    public static let toolLabels = [
        "computer_screen_observe": "观察屏幕",
        "computer_screen_screenshot": "截取屏幕",
        "computer_mouse_click": "点击",
        "computer_keyboard_type": "输入文字",
        "computer_scroll": "滚动",
        "computer_app_launch": "打开应用",
        "computer_app_activate": "激活应用"
    ]
}
