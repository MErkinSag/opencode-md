NATIVE_BODY_SENTINEL

- BULLET_FIRST with **bold**, `code`, and a [link](https://example.com).
- WRAPPED_BULLET This intentionally long item should wrap underneath its own text rather than underneath the bullet. It should continue to use the same native text renderer, maintain selection, and fit when the terminal becomes narrower.
  - NESTED_BULLET with a hollow circle.
  - Another nested item.
- [ ] TASK_OPEN
- [x] TASK_DONE

9. NUMBER_NINE starts at nine rather than being reset to one.
10. NUMBER_TEN This numbered item should wrap with the same hanging alignment as an ordinary bullet, including when the marker becomes two digits wide. Native text remains selectable and scrolling should not perform extra decoration work.
    1. NESTED_NUMBER remains numbered.
11. NUMBER_ELEVEN

AFTER_LIST_SENTINEL
