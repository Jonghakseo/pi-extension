# a4 one-time setup

The DOCX converter and checkers are Python scripts. They need `python3` and the `python-docx` library (which pulls in `lxml`). The optional HTML converter uses `markdown-it`, which Pi installs with this package.

## Check

```bash
python3 -c "import docx; print('python-docx ok')"
```

If this prints `python-docx ok`, nothing else is needed.

## Install (once)

1. Make sure `python3` exists: `python3 --version`. If not, run `xcode-select --install` or `brew install python`.
2. Install `python-docx` for the current user:

   ```bash
   python3 -m pip install --user python-docx
   ```

3. Homebrew Python refuses step 2 with `externally-managed-environment` (PEP 668). In that case install into the user site explicitly:

   ```bash
   python3 -m pip install --user --break-system-packages python-docx
   ```

   `--user` keeps the library out of Homebrew's own directory, so `brew upgrade` is not affected. After a major Python upgrade (for example 3.13 to 3.14), run the command again.

4. Run the check above again.

## Fonts

Custom fonts such as Pretendard must be installed in macOS before Word can render them. Check with `fc-list | grep -i pretendard` or `system_profiler SPFontsDataType`.
