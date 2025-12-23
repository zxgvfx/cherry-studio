# 中心化配置管理使用说明

## 自定义中心化配置文件路径

中心化配置文件的路径可以通过以下三种方式自定义（按优先级从高到低）：

### 1. 通过构造函数参数（代码中设置）

在创建 `CentralizedConfigManager` 实例时传入自定义路径：

```typescript
import { CentralizedConfigManager } from './CentralizedConfigManager'

// 使用绝对路径
const manager = new CentralizedConfigManager('/path/to/your/centralized-config.json')

// 或使用相对路径（相对于当前工作目录）
const manager = new CentralizedConfigManager('./configs/centralized-config.json')
```

### 2. 通过环境变量（推荐）

设置环境变量 `CENTRALIZED_CONFIG_PATH`：

**Windows (PowerShell):**
```powershell
$env:CENTRALIZED_CONFIG_PATH = "D:\path\to\centralized-config.json"
```

**Windows (CMD):**
```cmd
set CENTRALIZED_CONFIG_PATH=D:\path\to\centralized-config.json
```

**Linux/macOS:**
```bash
export CENTRALIZED_CONFIG_PATH=/path/to/centralized-config.json
```

**在 .env 文件中设置（如果使用 dotenv）:**
```env
CENTRALIZED_CONFIG_PATH=/path/to/centralized-config.json
```

**从 Python 启动时设置:**
```python
import os
import subprocess

# 设置环境变量
os.environ['CENTRALIZED_CONFIG_PATH'] = '/path/to/centralized-config.json'

# 然后启动 Electron 应用
subprocess.Popen(['electron', 'path/to/app'])
```

### 3. 默认路径（如果未指定）

如果既没有提供构造函数参数，也没有设置环境变量，将使用默认路径：

- **开发环境**: `{app.getAppPath()}/centralized-config.json`
- **生产环境**: `{app.getAppPath()}/resources/centralized-config.json`

## 路径格式说明

- **绝对路径**: 直接使用，如 `/home/user/config.json` 或 `C:\Users\user\config.json`
- **相对路径**: 会解析为相对于当前工作目录的绝对路径

## 示例

### 示例 1: 在应用启动时从 Python 设置

```python
# main.py
import os
import sys

# 设置中心化配置文件路径
config_path = os.path.join(os.path.dirname(__file__), 'configs', 'centralized-config.json')
os.environ['CENTRALIZED_CONFIG_PATH'] = config_path

# 启动 Electron 应用
# ...
```

### 示例 2: 在 TypeScript 代码中动态设置

```typescript
// 从用户配置或其他来源获取路径
const customConfigPath = getConfigPathFromSettings()

// 创建自定义路径的管理器
const centralizedConfigManager = new CentralizedConfigManager(customConfigPath)

// 使用 ConfigService 时，需要传入自定义的管理器
import { ConfigService } from './ConfigService'

// 注意：如果使用单例，需要修改 ConfigService 来支持自定义管理器
```

### 示例 3: 使用环境变量（最简单）

在启动脚本中：

```bash
#!/bin/bash
export CENTRALIZED_CONFIG_PATH="/opt/cherrystudio/configs/centralized-config.json"
npm start
```

或在 package.json 的 scripts 中：

```json
{
  "scripts": {
    "start": "CENTRALIZED_CONFIG_PATH=/path/to/config.json electron-vite dev"
  }
}
```

## 注意事项

1. 路径优先级：构造函数参数 > 环境变量 > 默认路径
2. 如果指定的文件不存在，系统会使用空配置并记录警告日志
3. 配置文件必须是有效的 JSON 格式
4. 中心化配置是只读的，无法通过代码修改

