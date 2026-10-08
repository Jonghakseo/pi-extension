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

## Smoke test

`import docx` only proves the library loads. Convert a throwaway file end to end once. `<skill-dir>` is the directory holding `SKILL.md`; always call the scripts through `python3` because installed copies have no execute bit.

```bash
cd "$(mktemp -d)"
printf '# Smoke title\n\n## Section\n\nPlain paragraph.\n' > smoke.md
python3 <skill-dir>/scripts/md-to-a4-docx.py smoke.md -o smoke.docx
python3 <skill-dir>/scripts/check-a4-docx.py smoke.docx smoke.md
```

The checker must print `A4 DOCX check: OK` and `Full ordered text: OK` and exit 0. Delete the temp directory afterwards.

## Fonts

The default style profile asks Word for **Noto Sans CJK KR**, which macOS does not ship. Without it Word silently substitutes another face, so the printed result differs from the spec.

```bash
system_profiler SPFontsDataType | grep -i "Noto Sans CJK KR"   # prints matches when installed
brew install --cask font-noto-sans-cjk-kr                      # install once
```

Custom fonts such as Pretendard must also be installed in macOS before Word can render them. Check them the same way:

```bash
system_profiler SPFontsDataType | grep -i pretendard
```

`fc-list | grep -i pretendard` is shorter, but `fc-list` comes from fontconfig and is not part of macOS. Use it only if `brew install fontconfig` is already done.
