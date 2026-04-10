# 理枢 Local Bridge

这是理枢 `商科 AutoResearch` 的独立本地桥接器项目。

它的作用是：

- 在你的电脑上调用 `Claude CLI` 或 `Codex CLI`
- 让 AutoResearch 的 run 目录与中间文件保留在你的主机上
- 避免把桥接器和公开网站源码放在同一目录中运行

## 启动

```bash
npm run local-bridge
```

默认地址：

```text
http://127.0.0.1:4318
```

## HTTPS 模式

先生成本地证书：

```bash
npm run local-bridge:cert
```

再启动 HTTPS bridge：

```bash
npm run local-bridge:https
```

默认 HTTPS 地址：

```text
https://127.0.0.1:4318
```

## 目录结构

- `bridge.js`: 本地桥接器主程序
- `generate-cert.sh`: 生成 localhost 自签名证书
- `certs/`: 本地证书目录

## 配合理枢使用

1. 打开理枢的 `商科 AutoResearch` 页面
2. 填入本地桥接器地址
3. 点击 `打开本地桥接器` 或 `连接本地桥接器`
4. 如果使用 HTTPS，先在浏览器中接受本地证书
5. 选择本地目录并测试写入
6. 选择 `Claude CLI` 或 `Codex CLI` 后启动任务
