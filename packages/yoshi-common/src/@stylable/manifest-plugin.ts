import { basename } from 'path';
import {
  stripOrganization,
  getProjectArtifactVersion,
} from 'yoshi-helpers/build/utils';
import { inTeamCity as checkInTeamCity } from 'yoshi-helpers/build/queries';
import { resolveNamespaceFactory } from './node';

/**
 * Creates a stylable manifest plugin
 * Stylable can produce data about a library's filesystem, stylesheet dependancy graph and more
 * Used to allow integrating with Stylable Panel
 * @param name package's name
 */
export const getStylableManifestPlugin = (name: string) => {
  /**
   * Not all stylesheets are components, this Rexgex is used to filter and determine what stylesheets are included in the manifest.
   */
  const COMPONENT_STYLESHEET_CONVENTION = /\.component\.st\.css$/;
  try {
    const inTeamCity = checkInTeamCity();
    // expected to be installed on the project that tests stylable-loader experimental feature
    // eslint-disable-next-line import/no-extraneous-dependencies
    const {
      StylableManifestPlugin,
    }: typeof import('@stylable/webpack-extensions') = require('@stylable/webpack-extensions');
    return new StylableManifestPlugin({
      package: {
        name,
        version: inTeamCity ? getProjectArtifactVersion(name) : '0.0.0',
      },
      outputType: 'fs-manifest',
      resolveNamespace: resolveNamespaceFactory(name),
      filterComponents(resourcePath: string) {
        return COMPONENT_STYLESHEET_CONVENTION.test(resourcePath);
      },
      getCompId(resourcePath: string) {
        return basename(resourcePath).replace(
          COMPONENT_STYLESHEET_CONVENTION,
          '',
        );
      },
      getOutputFileName(contentHash: string) {
        return `${stripOrganization(name)}.${contentHash}.metadata.json`;
      },
      /**
       * TODO - this is a workaround for stylable panel
       * It depends on `wix-ui-santa` string and should be removed once resolved by Core@3
       */
      packageAlias: {
        'wix-ui-santa': `/${name}`,
      },
    });
  } catch (e) {
    console.error(
      'Failed creating stylable manifest plugin. \n `@stylable/webpack-extensions` should be installed to support this feature',
    );
    throw e;
  }
};
