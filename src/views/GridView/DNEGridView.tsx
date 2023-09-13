import {ObservableMap, observable} from "mobx";
import {observer, useLocalObservable} from "mobx-react";
import {Link, useSearchParams} from "react-router-dom";
import {FaCubes} from "react-icons/fa";
import {Form} from "react-bootstrap";
import {
  Builder,
  Build,
  Change,
  useDataAccessor,
  useDataApiQuery,
  useDataApiDynamicQuery,
  DataMultiCollection,
} from "buildbot-data-js";
import {
  LoadingIndicator,
  pushIntoMapOfArrays,
  ChangeDetails,
  BuildLinkWithSummaryTooltip
} from "buildbot-ui";
import {buildbotGetSettings, buildbotSetupPlugin, RegistrationCallbacks} from "buildbot-plugin-support";
import {DNEViewSelectManager} from "./Utils";
import {getConfig, DNEConfig, DNEView} from "./Config";
import {getRelatedOfFilteredDataMultiCollection} from "./DataMultiCollectionUtils";

function getViewSelectForm(config: DNEConfig) {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewSelectManager = new DNEViewSelectManager(config, searchParams, setSearchParams);

  const projectViews = viewSelectManager.getBranchOrDefault()?.views ?? [];

  const groupedViews = Array.from(projectViews.reduce(function(rv, view: DNEView) {
    const key = view.display_group;
    rv.get(key)?.push(view) ?? rv.set(key, [view]);
    return rv;
  }, new Map<string, DNEView[]>()));

  const selectForms = (
    <Form inline className="mb-sm-2">
    <Form.Label className="mr-sm-2">Project</Form.Label>
      <Form.Control className="mr-sm-2" as="select" multiple={false} value={viewSelectManager.getProjectId().toString()}
                    onChange={event => viewSelectManager.setProjectId(event.target.value)}>
        {viewSelectManager.config.projects.map(p => (<option value={p.identifier}>{p.display_name}</option>))}
      </Form.Control>
      <Form.Label className="mr-sm-2">Branch</Form.Label>
      <Form.Control className="mr-sm-2" as="select" multiple={false} value={viewSelectManager.getBranchId()}
                    onChange={event => viewSelectManager.setBranch(event.target.value)}>
        {viewSelectManager.getProjectOrDefault()?.branches.map(branch => (<option value={branch.identifier}>{branch.display_name}</option>))}
      </Form.Control>
      <Form.Label className="mr-sm-2">View</Form.Label>
      <Form.Control className="mr-sm-2" as="select" multiple={false} value={viewSelectManager.getViewId()}
                    onChange={event => viewSelectManager.setView(event.target.value)}>
        {groupedViews.map(([key, values]) => (<optgroup label={key}>{values.map(view => <option value={view.identifier}>{view.display_name}</option>)}</optgroup>))}
      </Form.Control>
    </Form>
  );

  const viewTag = viewSelectManager.getViewTag();

  return {form: selectForms, viewTag: viewTag};
}

function getGotRevisionFromBuild(build: Build) {
  if (build.properties !== null && ('got_revision' in build.properties)) {
    const revision = build.properties['got_revision'][0];
    if (typeof(revision) === "string") {
      return revision;
    }
  }

  return null;
}

function getDatas(viewTag: string, buildFetchLimit: number) {
  const accessor = useDataAccessor([]);

  const buildersQuery = useDataApiQuery(() => Builder.getAll(accessor, {query: {order: 'name'}}));
  const builders: Builder[] = buildersQuery
    .array
    .filter((b: Builder) => b.tags.indexOf(viewTag) >= 0);

  const builderIds = observable(builders.map((b: Builder) => b.id));

  const buildrequestsQuery = useDataApiDynamicQuery(builderIds, () => {
    if (builderIds.length <= 0) {
      return null;
    }
    console.log('Run buildrequestsQuery');

    return buildersQuery.getRelatedOfFiltered(
      builderIds,
      (builder: Builder) => {
        return builder.getBuildrequests({query: {
          order: '-buildrequestid',
          claimed: false,
        }})
      });
  });

  const buildsQuery = useDataApiDynamicQuery(builderIds, () => {
    if (builderIds.length <= 0) {
      return null;
    }
    console.log('Run buildsQuery');

    return buildersQuery.getRelatedOfFiltered(
      builderIds,
      (builder: Builder) => {
        return builder.getBuilds({query: {
          limit: buildFetchLimit,
          order: '-buildid',
          property: ["got_revision"],
        }})
      });
  });
  const buildsQueryIsResolved = buildsQuery?.isResolved() ?? false;
  const buildsQueryState = buildsQueryIsResolved ? buildsQuery.getAll().map((b: Build) => `${b.buildid}|${b.complete}`) : [];

  const changesQuery = useDataApiDynamicQuery(
    buildsQueryState,
    () => {
      if (!buildsQueryIsResolved) {
        return null;
      }
      console.log('Run changesQuery');
      return getRelatedOfFilteredDataMultiCollection(
        buildsQuery,
        // Will get revision from lighter method /api/v2/changes?revision={rev}
        buildsQuery.getAll().filter((b: Build) => getGotRevisionFromBuild(b) === null).map((b: Build) => b.id),
        (b: Build) => {
          return b.getChanges({query: {limit: 1, order: '-changeid'}})
        }
      );
    }
  );

  const changesRevisions = new Set<string>();
  if (changesQuery?.isResolved() ?? false) {
    for (const change of changesQuery.getAll()) {
      if (change.revision !== null) {
        changesRevisions.add(change.revision);
      }
    }
  }

  const changesByRevisionQueryDependencies = (buildsQuery?.isResolved() ?? false) && (changesQuery?.isResolved() ?? false)
  const changesByRevisionQuery = useDataApiDynamicQuery(
    [changesByRevisionQueryDependencies],
      () => {
        if (!changesByRevisionQueryDependencies) {
          return null;
        }
        console.log('Run changesByRevisionQuery');

        const filteredBuilds = buildsQuery.getAll().filter((build: Build) => {
          if (changesQuery.getNthOfParentOrNull(build.buildid.toString(), 0) !== null) {
            // already got change for this build
            return false;
          }
          const gotRevision = getGotRevisionFromBuild(build);
          if (gotRevision === null) {
            // No rev info for this build
            return false;
          }
          if (changesRevisions.has(gotRevision)) {
            // Already got the change for this revision through another call
            return false;
          }

          // we'll query for this revision, add it to known ones to avoid multiple queries
          changesRevisions.add(gotRevision);
          return true;
        }).map((build: Build) => build.id);

        return getRelatedOfFilteredDataMultiCollection(
          buildsQuery,
          filteredBuilds,
          (build: Build) => Change.getAll(accessor, {query: {limit: 1, order: '-changeid', revision: getGotRevisionFromBuild(build)!}})
        );
      },
    );

  const queriesResolved = [
    buildersQuery,
    buildrequestsQuery,
    buildsQuery,
    changesQuery,
    changesByRevisionQuery,
  ].every(q => q?.isResolved() ?? false);

  return {
    queriesResolved,
    builders,
    buildrequestsQuery,
    buildsQuery,
    changesQuery,
    changesByRevisionQuery,
  };
}

export const DNEGridView = observer(() => {
  const config: DNEConfig = getConfig();
  const settings = buildbotGetSettings();
  const buildFetchLimit = settings.getIntegerSetting("DNEGrid.buildFetchLimit");
  const {form: viewSelectForm, viewTag} = getViewSelectForm(config);
  const {
    queriesResolved,
    builders,
    buildrequestsQuery,
    buildsQuery,
    changesQuery,
    changesByRevisionQuery,
  } = getDatas(viewTag, buildFetchLimit);

  const changeIsExpandedByChangeId = useLocalObservable(() => new ObservableMap<number, boolean>());

  // FIXME: fa-spin
  if (!queriesResolved) {
    return (
      <div className="bb-grid-container">
        {viewSelectForm}
        <LoadingIndicator/>
      </div>
    );
  }

  const changeByRevision = new Map<string, Change>();
  for (const change of changesQuery.getAll()) {
    const revision = change?.revision;
    if (revision && !changeByRevision.has(revision)) {
      changeByRevision.set(revision, change);
    }
  }
  for (const change of changesByRevisionQuery.getAll()) {
    const revision = change?.revision;
    if (revision && !changeByRevision.has(revision)) {
      changeByRevision.set(revision, change);
    }
  }

  let fakeChangeId = -1;

  const buildsByChanges = new Map<string | null, {change: Change | null, revision: string | null, builds: Map<string, Build[]>}>();
  for (const builder of builders) {
    const buildsCollection = (buildsQuery as DataMultiCollection<Builder, Build>).getParentCollectionOrEmpty(builder.id);
    for (const build of buildsCollection.array) {
      const revision = getGotRevisionFromBuild(build);
      let change: Change | null = null;
      if (revision) {
        change = changeByRevision.get(revision) ?? null;
      }

      if (change === null) {
        change = changesQuery.getNthOfParentOrNull(build.buildid.toString(), 0);
      }
      if (change === null) {
        // Did we do a request for this build?
        change = changesByRevisionQuery.getNthOfParentOrNull(build.buildid.toString(), 0);
      }

      let changeid = change?.revision ?? revision;
      if (changeid === null) {
        changeid = fakeChangeId.toString();
        fakeChangeId -= 1;
      }

      if (!buildsByChanges.has(changeid)) {
        buildsByChanges.set(changeid, {change: change, revision, builds: new Map<string, Build[]>()});
      }

      pushIntoMapOfArrays(buildsByChanges.get(changeid)!.builds, builder.id, build);
    }
  }
  const buildsAndChanges = Array.from(buildsByChanges.values());
  buildsAndChanges.sort((left, right) => {
    if (left.change !== null && right.change !== null) {
      return right.change.when_timestamp - left.change.when_timestamp;
    }
    const leftMin = Math.min(...Array.from(left.builds.values()).flat().map((b: Build) => b.started_at));
    const rightMin = Math.min(...Array.from(right.builds.values()).flat().map((b: Build) => b.started_at));
    return rightMin - leftMin;
  }).splice(buildFetchLimit);

  const bodyIntermediate = buildsAndChanges.map(({change, revision, builds}) => {
    let changeUI;
    if (change) {
      changeUI = (
        <ChangeDetails change={change} compact={false}
          showDetails={changeIsExpandedByChangeId.get(change.changeid) ?? false}
          setShowDetails={(show: boolean) => changeIsExpandedByChangeId.set(change.changeid, show)}
        />
      );
    }
    else if (revision) {
      changeUI = revision;
    }
    else {
      changeUI = "ChangeNotFound";
    }
    return {
      change: changeUI,
      buildersUI: builders.map((b: Builder) => {
        return <td>{builds.get(b.id)?.map((build: Build) => <BuildLinkWithSummaryTooltip key={build.buildid} build={build}/>)}</td>
      })
    };
  });

  const body = bodyIntermediate.map(({change, buildersUI}) => {
    return (
    <tr>
      <td>
        {change}
      </td>
      {buildersUI}
    </tr>
    );
  });

  return (
    <div className="container grid">
      {viewSelectForm}
      <table className="table table-condensed table-striped table-hover">
        <thead>
          <tr>
            <th style={{width: 200}}>Change</th>
            {builders.map(builder => {
              const watiningRequests = buildrequestsQuery.getParentCollectionOrEmpty(builder.id)?.array.length;
              const waitingRequestsUI = watiningRequests > 0 ? <div>{watiningRequests} waiting</div> : "";
              return <th><Link to={`/builders/${builder.builderid}`}>{builder.name}</Link>{waitingRequestsUI}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {body}
        </tbody>
      </table>
    </div>
  );
});

buildbotSetupPlugin((reg: RegistrationCallbacks) => {
  reg.registerMenuGroup({
    name: 'dne_grid',
    caption: 'DNE Grid View',
    icon: <FaCubes/>,
    order: 4,
    route: '/dne_grid',
    parentName: null,
  });

  reg.registerRoute({
    route: "/dne_grid",
    group: "dne_grid",
    element: () => <DNEGridView/>,
  });

  reg.registerSettingGroup({
    name: "DNEGrid",
    caption: "DNEGrid related settings",
    items: [
      {
        type: 'integer',
        name: 'buildFetchLimit',
        caption: 'Maximum number of builds to retrieve per builder',
        defaultValue: 20,
      }
    ]
  });
});

export default DNEGridView;
