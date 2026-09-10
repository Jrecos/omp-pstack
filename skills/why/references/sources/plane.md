# Plane work items

## What this source contains

- Work item descriptions and comments recording requests, decisions, and scope changes
- Parent work items that explain the broader initiative
- Projects, modules, cycles, labels, and linked pages that provide product context
- Activity records that place changes in time

## How to search it

Use the connected Plane MCP. Keep the investigation read-only, even when a tool also offers mutation actions.

Discover the advertised tools and read their schemas before calling them. Official releases use two naming schemes:

| Read operation | Resource tools | Per-operation tools |
|---|---|---|
| List projects | `project(action="list")` | `list_projects` |
| Retrieve a work item | `workitem(action="retrieve")` | `retrieve_work_item` |
| Resolve a human identifier | `workitem(action="retrieve_by_identifier")` | `retrieve_work_item_by_identifier` |
| Search work items | `workitem(action="search")` | `search_work_items` |
| List work items | `workitem(action="list")` | `list_work_items` |
| Read comments | `workitem_comment(action="list")` | `list_work_item_comments` |

Use only the scheme the connected server advertises. Do not substitute Linear's `get_issue` or `list_issues`.

1. Start with work item identifiers linked from seed commits or PRs. The resource tool accepts `workitem_identifier="ENG-42"`. Older identifier tools use `project_identifier="ENG"` and `issue_identifier=42`. Confirm those arguments against the live schema.
2. Resolve IDs before further reads. A project's `identifier`, such as `ENG`, differs from its UUID `id`. A work item's `sequence_id`, such as `42`, differs from its UUID `id`. Project-scoped reads need `project_id`. Resource tools use `workitem_id`, while older tools use `work_item_id`.
3. Read the full description and fetch comments separately. Preserve exact quotations from `description_stripped` or `comment_stripped` when returned. Otherwise extract readable text from HTML without paraphrasing the evidence.
4. Search related work items by feature name, symbol, customer, and error text. Use the search tool's advertised `query` parameter. For a newer list tool's `pql` parameter, read `get_pql_reference` first. Do not assume grouping keys such as `state__group` are valid filters.
5. Follow the `parent` UUID to the broader work item. Read linked modules, cycles, pages, and activity when the connected server exposes those operations. Use their schemas rather than inventing tool names or actions.
6. Follow pagination according to the response and tool schema. Stop when `next_page_results` is false, even if `next_cursor` remains populated. When more pages exist, pass the returned cursor. If pagination metadata is absent or a cursor repeats, record incomplete coverage rather than claiming the full tracker was searched.

## What good evidence looks like here

- A description naming the customer problem or business requirement
- A comment explaining the chosen approach and a rejected alternative
- A parent work item or linked page recording the initiative or specification
- A module or cycle connecting the change to a deadline
- An activity record showing when scope changed

## Common pitfalls

- **Workspace scope.** The MCP connection selects a workspace. Record that scope. Use project UUIDs when required, and distinguish workspace-wide searches from project-scoped lists.
- **Version mismatch.** A newer MCP release can use an endpoint an older self-hosted instance lacks. For example, newer project-list tools use a lite endpoint, while release 0.2.8 uses the standard projects endpoint. A 404 is a failed read, not evidence that no projects exist. Report the failing operation and version. Do not upgrade or reconfigure the user's server during an investigation.
- **Missing capabilities.** A missing tool, permission error, or inaccessible page is an evidence gap. Do not infer that the underlying feature or content is absent.
- **Archived items and changed scope.** List operations may exclude archived items. Use an advertised archived-read operation when relevant, and compare comments and activity dates with the code's ship date.
- **Labels and states.** They provide context, not proof of motivation. Find the description, comment, or page that explains the decision.

## What to return

For each relevant work item:

- Human identifier, title, work item UUID, and project
- Exact motivation or decision quotation and the field or comment it came from
- Relevant parent, module, cycle, labels, and linked pages
- Author and timestamps when available
- A URL returned by the source or already present in the seed evidence. Do not invent a link from an identifier
- The tools used, pagination coverage, and failed reads or unavailable capabilities

## Tool reference

[Official Plane MCP server](https://github.com/makeplane/plane-mcp-server). The connected server's tool schemas determine the available operations.
