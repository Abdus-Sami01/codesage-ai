import sys
import os
from huggingface_hub import InferenceClient
import pygments.lexers  # Improved language detection
from pygments.util import ClassNotFound

# Load API Key from Environment Variable
HF_API_KEY = "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" 
if not HF_API_KEY:
    print("Error: Missing API Key. Set 'HF_API_KEY' as an environment variable.")
    sys.exit(1)

# Hugging Face Inference Client
client = InferenceClient(
    provider="together",
    api_key=HF_API_KEY
)

def detect_language(code):
    """Improved detection of programming language using Pygments."""
    try:
        lexer = pygments.lexers.guess_lexer(code)
        return lexer.name  # Example: "Python", "JavaScript", "C++"
    except ClassNotFound:
        return "Unknown"

def review_code(code):
    """Sends the code to DeepSeek-R1 for a review with correct language detection."""
    language = detect_language(code)

    # If detection is unreliable, prompt the user
    if language == "Unknown" or language in ["GDScript", "Plain Text"]:
        print("\n⚠️  Language detection is uncertain. Please specify the language (e.g., Python, PHP, C++).")
        language = input("Enter the programming language: ").strip()

    print(f"\n🔍 Detected Language: {language}")
    print("\n📌 Reviewing Code...\n")

    messages = [
        {"role": "user", "content": f"Review this {language} code and suggest improvements:\n\n{code}"}
    ]

    try:
        response = client.chat.completions.create(
            model="deepseek-ai/DeepSeek-R1",  
            messages=messages,
            max_tokens=500,
        )

        # Extract AI response
        raw_response = response.choices[0].message.content if response.choices else "No response from AI."

        # Pretty format AI response
        formatted_response = "\n\033[1m💡 AI Code Review Response:\033[0m\n"
        formatted_response += "-" * 60 + "\n"
        formatted_response += raw_response.replace("\n", "\n\n")  

        print(formatted_response)

    except Exception as e:
        print(f"\n❌ Error: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python code_review.py \"<your_code_here>\"")
        sys.exit(1)

    code = sys.argv[1]
    review_code(code)
