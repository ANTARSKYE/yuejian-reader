"""Provider-specific HTTP client for Yuejian AI requests."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request


def _openai_output_text(response):
    if response.get("output_text"):
        return response["output_text"]
    parts = []
    for item in response.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in ("output_text", "text"):
                parts.append(content.get("text", ""))
    return "\n".join(parts)


def request(config, instructions, user_input, json_output=False, max_tokens=8000):
    key = config.get("key", "")
    if not key:
        raise ValueError("尚未配置 API 密钥。请点击页面右上角的「AI 设置」。")
    provider = config.get("provider")
    if provider == "deepseek":
        body = {
            "model": config["model"],
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": user_input},
            ],
            "stream": False,
            "max_tokens": max_tokens,
        }
        if json_output:
            body["response_format"] = {"type": "json_object"}
        url = "https://api.deepseek.com/chat/completions"
    elif provider == "openai":
        body = {
            "model": config["model"],
            "instructions": instructions,
            "input": user_input,
            "max_output_tokens": max_tokens,
        }
        url = "https://api.openai.com/v1/responses"
    else:
        raise ValueError("不支持的 AI 服务商。")

    payload = json.dumps(body).encode("utf-8")
    http_request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(http_request, timeout=180) as response:
                data = json.loads(response.read().decode("utf-8"))
                if provider == "deepseek":
                    return data.get("choices", [{}])[0].get("message", {}).get("content", "")
                return _openai_output_text(data)
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", errors="replace")
            last_error = ValueError(
                f"AI 服务返回错误（HTTP {error.code}）：{details[:400]}"
            )
            if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                break
        except urllib.error.URLError as error:
            last_error = ValueError(f"无法连接 AI 服务：{error.reason}")
            if attempt == 2:
                break
        time.sleep(0.8 * (2**attempt))
    raise last_error or ValueError("AI 服务请求失败。")
