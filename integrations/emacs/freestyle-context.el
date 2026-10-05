;;; freestyle-context.el --- Context snapshots for Freestyle  -*- lexical-binding: t; -*-

;; Package-Requires: ((emacs "29.1"))
;; Keywords: convenience

;;; Commentary:

;; This library exposes a small, bounded snapshot of the active Emacs
;; context for Freestyle's context-aware transcription integration.

;;; Code:

(require 'imenu)
(require 'json)

(defconst freestyle-context-version "1"
  "Version of the Freestyle context snapshot format.")

(defconst freestyle-context--visible-text-limit 2000
  "Maximum number of characters returned as visible text.")

(defconst freestyle-context--selected-window-limit 1200
  "Preferred visible-text allowance for the selected window.")

(defconst freestyle-context--item-limit 100
  "Maximum number of symbols or open buffers returned.")

(defun freestyle-context--effective-window ()
  "Return the context window, accounting for an active minibuffer."
  (condition-case nil
      (let ((window (selected-window)))
        (if (window-minibuffer-p window)
            (let ((previous (minibuffer-selected-window)))
              (if (window-live-p previous) previous window))
          window))
    (error nil)))

(defun freestyle-context--window-text (window limit)
  "Return up to LIMIT visible characters from WINDOW without properties."
  (condition-case nil
      (when (and (window-live-p window) (> limit 0))
        (with-current-buffer (window-buffer window)
          (let* ((start (max (point-min) (window-start window)))
                 (window-end (window-end window t))
                 (end (and window-end
                           (min (point-max) window-end (+ start limit)))))
            (when (and end (> end start))
              (buffer-substring-no-properties start end)))))
    (error nil)))

(defun freestyle-context--visible-text (window)
  "Return bounded visible text from WINDOW's frame, with WINDOW first."
  (condition-case nil
      (when (window-live-p window)
        (let* ((windows (window-list (window-frame window) 'nomini window))
               (windows-left (length windows))
               (remaining freestyle-context--visible-text-limit)
               pieces)
          (dolist (candidate windows)
            (when (> remaining 0)
              (let* ((separator-size (if pieces 1 0))
                     (available (max 0 (- remaining separator-size)))
                     (allowance
                      (if (and (eq candidate window) (> windows-left 1))
                          (min freestyle-context--selected-window-limit
                               available)
                        (if (> windows-left 0)
                            (/ (+ available windows-left -1) windows-left)
                          0)))
                     (text (freestyle-context--window-text
                            candidate allowance)))
                (when (and text (> (length text) 0))
                  (push text pieces)
                  (setq remaining
                        (- remaining separator-size (length text))))))
            (setq windows-left (1- windows-left)))
          (when pieces
            (let ((text (mapconcat #'identity (nreverse pieces) "\n")))
              (if (> (length text) freestyle-context--visible-text-limit)
                  (substring text 0 freestyle-context--visible-text-limit)
                text)))))
    (error nil)))

(defun freestyle-context--language (buffer)
  "Return BUFFER's major-mode name without a trailing \"-mode\"."
  (condition-case nil
      (with-current-buffer buffer
        (when (symbolp major-mode)
          (let* ((name (symbol-name major-mode))
                 (name-length (length name)))
            (if (and (>= name-length 5)
                     (string= (substring name -5) "-mode"))
                (substring name 0 -5)
              name))))
    (error nil)))

(defun freestyle-context--flatten-imenu (index)
  "Return up to 100 leaf names from the imenu INDEX."
  (condition-case nil
      (let ((stack (list index))
            names)
        (while (and stack (< (length names) freestyle-context--item-limit))
          (let ((entries (pop stack)))
            (when (consp entries)
              (let ((entry (car entries)))
                (when (cdr entries)
                  (push (cdr entries) stack))
                (cond
                 ((imenu--subalist-p entry)
                  (push (cdr entry) stack))
                 ((and (consp entry)
                       (stringp (car entry))
                       (not (string= (car entry) "*Rescan*")))
                  (push (substring-no-properties (car entry)) names)))))))
        (nreverse names))
    (error nil)))

(defun freestyle-context--symbols (buffer)
  "Return a bounded list of imenu symbol names from BUFFER."
  (condition-case nil
      (with-current-buffer buffer
        (let ((index
               (or imenu--index-alist
                   (let ((imenu-auto-rescan nil)
                         (imenu--index-alist nil))
                     (save-match-data
                       (save-excursion
                         (save-restriction
                           (imenu--make-index-alist t))))))))
          (freestyle-context--flatten-imenu index)))
    (error nil)))

(defun freestyle-context--open-buffers (current)
  "Return names of up to 100 recent file buffers other than CURRENT."
  (condition-case nil
      (let (names)
        (dolist (buffer (buffer-list))
          (when (and (< (length names) freestyle-context--item-limit)
                     (buffer-live-p buffer)
                     (not (eq buffer current))
                     (ignore-errors
                       (buffer-local-value 'buffer-file-name buffer)))
            (let ((name (buffer-name buffer)))
              (when name
                (push (substring-no-properties name) names)))))
        (nreverse names))
    (error nil)))

;;;###autoload
(defun freestyle-context-snapshot ()
  "Return a bounded JSON string describing the active Emacs context.

All fields are best-effort and omitted when unavailable.  This function
does not signal errors."
  (condition-case nil
      (let* ((window (freestyle-context--effective-window))
             (buffer (and (window-live-p window) (window-buffer window)))
             (snapshot (make-hash-table :test #'equal)))
        (when (buffer-live-p buffer)
          (let ((file (ignore-errors
                        (buffer-local-value 'buffer-file-name buffer)))
                (language (freestyle-context--language buffer))
                (visible-text (freestyle-context--visible-text window))
                (symbols (freestyle-context--symbols buffer))
                (open-buffers (freestyle-context--open-buffers buffer)))
            (when file
              (puthash "file" file snapshot))
            (when language
              (puthash "language" language snapshot))
            (when visible-text
              (puthash "visibleText" visible-text snapshot))
            (when symbols
              (puthash "symbols" (vconcat symbols) snapshot))
            (when open-buffers
              (puthash "openBuffers" (vconcat open-buffers) snapshot))))
        (json-serialize snapshot))
    (error "{}")))

(defun freestyle-insert-file (path)
  "Insert the UTF-8 contents of PATH at point, then delete PATH.

Freestyle calls this instead of synthesizing a paste keystroke: Emacs binds
no paste to C-v, and clipboard round-trips are unreliable on Wayland. The
text arrives through a file so no shell or Elisp string quoting can corrupt
it.

Inserts into the window the user is looking at (the minibuffer when one is
active, matching where point is). Returns the number of characters inserted,
or nil when the buffer is read-only or anything else fails, so the caller can
fall back to its keystroke path."
  (condition-case nil
      (let* ((coding-system-for-read 'utf-8)
             (text (with-temp-buffer
                     (insert-file-contents path)
                     (buffer-string)))
             (window (freestyle-context--effective-window)))
        (ignore-errors (delete-file path))
        (when (and (window-live-p window) (> (length text) 0))
          (with-selected-window window
            (when buffer-read-only
              (signal 'buffer-read-only nil))
            (insert text)
            (length text))))
    (error
     (ignore-errors (delete-file path))
     nil)))

(provide 'freestyle-context)

;;; freestyle-context.el ends here
