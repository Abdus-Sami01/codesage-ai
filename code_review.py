"""
CodeSage AI -- Python Review Backend
====================================
Called by the VS Code extension as a child process.

Communication Protocol:
  - Input:  JSON via stdin  -> { "code": str, "language": str, "fileName": str }
  - Config: Environment variables ->
      HF_API_KEY, CODESAGE_MODEL, CODESAGE_MAX_TOKENS, CODESAGE_TEMPERATURE,
      CODESAGE_PROFILE, CODESAGE_SYSTEM_PROMPT, CODESAGE_STREAM
  - Output (non-streaming): single JSON -> { "content", "model", "tokens_used" } or { "error" }
  - Output (streaming): JSON lines -> { "type": "chunk", "content" } ... { "type": "done", ... }

Dependencies:
  pip install huggingface_hub
"""

import sys
import os
import json

from huggingface_hub import InferenceClient


# Fallback system prompt used when CODESAGE_SYSTEM_PROMPT is not set.

FALLBACK_SYSTEM_PROMPT = """You are CodeSage AI, an expert code reviewer. Analyze the provided code and deliver a comprehensive, actionable review in markdown format.

## Code Quality Rating
Rate the code from A (excellent) to F (critical issues).

## Issues Found
List each issue with severity, line number, description, and fix.

## Improvements
Suggest improvements with code examples.

## Security
Flag any security concerns.

## Summary
Top 3 action items."""


def main():
    """Entry point: read request from stdin, call AI, write response to stdout."""
    # Read configuration from environment
    api_key = os.environ.get("HF_API_KEY")
    if not api_key:
        output_error("Missing API key. Run 'CodeSage: Set API Key' from the command palette.")
        return

    model = os.environ.get("CODESAGE_MODEL", "deepseek-ai/DeepSeek-R1")
    max_tokens = int(os.environ.get("CODESAGE_MAX_TOKENS", "4096"))
    temperature = float(os.environ.get("CODESAGE_TEMPERATURE", "0.3"))
    system_prompt = os.environ.get("CODESAGE_SYSTEM_PROMPT", FALLBACK_SYSTEM_PROMPT)
    stream_mode = os.environ.get("CODESAGE_STREAM", "false").lower() == "true"

    # Read request from stdin
    try:
        raw_input = sys.stdin.read()
        request = json.loads(raw_input)
    except json.JSONDecodeError as e:
        output_error(f"Invalid input format: {e}")
        return

    code = request.get("code", "")
    language = request.get("language", "Unknown")
    file_name = request.get("fileName", "unknown")

    if not code.strip():
        output_error("No code provided for review.")
        return

    # Initialize HuggingFace client
    client = InferenceClient(
        provider="together",
        api_key=api_key,
    )

    # Build the prompt
    base_name = os.path.basename(file_name)
    user_prompt = f"Review this {language} code from `{base_name}`:\n\n```{language}\n{code}\n```"

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    # Call the AI model
    try:
        if stream_mode:
            _stream_response(client, model, messages, max_tokens)
        else:
            _standard_response(client, model, messages, max_tokens)
    except Exception as e:
        output_error(f"AI request failed: {e}")


def _standard_response(client, model, messages, max_tokens):
    """Non-streaming: collect full response, output as single JSON."""
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
    )

    content = (
        response.choices[0].message.content
        if response.choices
        else "No response received from the AI model."
    )

    tokens_used = 0
    if hasattr(response, "usage") and response.usage:
        tokens_used = getattr(response.usage, "total_tokens", 0)

    output_result({
        "content": content,
        "model": model,
        "tokens_used": tokens_used,
    })


def _stream_response(client, model, messages, max_tokens):
    """Streaming: output JSON lines as chunks arrive."""
    accumulated = []

    try:
        stream = client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            stream=True,
        )

        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                text = chunk.choices[0].delta.content
                accumulated.append(text)
                output_chunk(text)

        # Send final done message
        full_content = "".join(accumulated)
        output_done(full_content, model)

    except Exception as e:
        # If streaming fails partway, try to send what we have
        if accumulated:
            full_content = "".join(accumulated)
            output_done(full_content, model)
        else:
            output_error(f"Streaming failed: {e}")


def output_result(data):
    """Write a successful result as JSON to stdout (non-streaming)."""
    sys.stdout.write(json.dumps(data))
    sys.stdout.flush()


def output_chunk(content):
    """Write a streaming chunk as a JSON line to stdout."""
    sys.stdout.write(json.dumps({"type": "chunk", "content": content}) + "\n")
    sys.stdout.flush()


def output_done(content, model):
    """Write the final streaming message as a JSON line to stdout."""
    sys.stdout.write(json.dumps({
        "type": "done",
        "content": content,
        "model": model,
        "tokens_used": 0,
    }) + "\n")
    sys.stdout.flush()


def output_error(message):
    """Write an error as JSON to stdout."""
    sys.stdout.write(json.dumps({"error": message}))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
